// endpoints/filetick.js — видеокачвейер: самые популярные mp4 без file_id качаем
// в облаке и льём в канал-дамп (lib/config.js), ТГ возвращает вечный file_id —
// дальше выдача из кэша ТГ без лимитов URL (1 МБ у mpeg4_gif / 20 МБ у video).
// Лимиты Bot API (core.telegram.org/bots/faq): ≤1 сообщения/сек в чат, ~20/мин на
// группу/канал, загрузка ≤50 МБ. Наш темп: ≤8 файлов за вызов, вызов раз в 30 с —
// потолок ~16/мин при лимите ~20/мин; 429 → просто стопаемся до следующего вызова.
// Проверка: npx tgcloud run endpoints/filetick '{}'

import { db, api, fetch, InputFile, BotApiError } from 'sdk';
import { claimTick } from '../lib/queue.js';
import { DUMP_CHAT_ID } from '../lib/config.js';

const INTERVAL_SEC = 30;   // между файловыми подходами
const MAX_FILES = 8;       // за подход — потолок ~16/мин при канальном лимите ~20/мин
const BUDGET_MS = 12000;   // вызов платформы ~20 с; перед нами мог отработать краул-тик
const MAX_BYTES = 29000000;   // sdk.fetch не отдаёт ответ больше ~30 МБ
const MIN_BYTES = 1000001;    // ≤1 МБ и так автогифка по URL — file_id не нужен (граница как в postToResult)

async function bodyBytes(res) {
  const parts = [];
  let n = 0;
  for await (const chunk of res.body) {
    parts.push(chunk);
    n += chunk.length;
  }
  const out = new Uint8Array(n);
  let off = 0;
  for (const c of parts) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// Проблема канала/бота, а не конкретного файла — помечать посты dead нельзя,
// иначе неверный канал или снятые права выкашивают весь бэклог за тики.
const CHAT_ERR = /chat (not found|has been|is not accessible)|not enough rights|bot was blocked|kicked|unauthorized|forbidden/i;

export default async function fileTick() {
  if (!(await claimTick('_file', INTERVAL_SEC))) return { done: 'too soon' };
  const rows = await db.all(
    `SELECT id, file_url, file_size FROM posts
     WHERE file_ext = 'mp4' AND file_id IS NULL AND file_kind IS NULL
       AND file_size BETWEEN :min AND :max
     ORDER BY hits DESC, id DESC LIMIT :l`,
    { ':min': MIN_BYTES, ':max': MAX_BYTES, ':l': MAX_FILES },
  );
  if (!rows.length) return { done: 'no candidates' };
  const t0 = Date.now();
  let processed = 0;
  for (const p of rows) {
    if (processed && Date.now() - t0 > BUDGET_MS) break; // первый файл пробуем всегда
    try {
      const res = await fetch(p.file_url, { headers: { 'user-agent': 'Ryle35InlineBot/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const cl = Number(res.headers.get('content-length') ?? 0);
      if (cl && cl > MAX_BYTES) throw new Error(`too big by header: ${cl}`);
      const bytes = await bodyBytes(res);
      if (bytes.length <= 1024) throw new Error(`suspicious size ${bytes.length}`);
      // новый InputFile на каждую попытку — тело читается один раз
      const mkFile = () => new InputFile(bytes, `${p.id}.mp4`, { type: 'video/mp4' });
      let msg, kind;
      try {
        msg = await api.sendAnimation({ chat_id: DUMP_CHAT_ID, animation: mkFile() }); // анимация = автоплей в инлайне
        kind = 'anim';
      } catch (e) {
        if (e instanceof BotApiError && e.code === 429) throw e; // лимит — без пометок, до следующего раза
        if (e instanceof BotApiError && CHAT_ERR.test(String(e.description))) throw e; // канал — фолбэк бесполезен
        msg = await api.sendVideo({ chat_id: DUMP_CHAT_ID, video: mkFile() }); // не анимация (кодек/формат) — хотя бы карточка
        kind = 'video';
      }
      const fid = msg?.animation?.file_id ?? msg?.document?.file_id ?? msg?.video?.file_id;
      if (!fid) throw new Error('no file_id in response');
      await db.run(
        'UPDATE posts SET file_id = :f, file_kind = :k WHERE id = :id',
        { ':f': fid, ':k': kind, ':id': p.id },
      );
      processed++;
    } catch (e) {
      if (e instanceof BotApiError && e.code === 429) {
        console.log(`filetick: 429 after ${processed}, stop`);
        break;
      }
      if (e instanceof BotApiError && CHAT_ERR.test(String(e.description))) {
        console.log(`filetick: channel problem (${e.description}), stop — посты не помечаем`);
        break;
      }
      // файл недоступен/битый — помечаем, чтобы не циклиться на нём каждый тик
      await db.run(`UPDATE posts SET file_kind = 'dead' WHERE id = :id`, { ':id': p.id });
      console.log(`filetick: post ${p.id} dead: ${e.message ?? e}`);
    }
  }
  console.log(`filetick: ${processed}/${rows.length} uploaded`);
  return { processed, tried: rows.length };
}

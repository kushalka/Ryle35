// lib/queue.js — очередь тегов для авто-пополнения БД (endpoints/tick.js).
// Каталог расширяется сам: теги, часто встретившиеся в найденных постах,
// добавляются в очередь с приоритетом на единицу ниже родительского.

import { db } from 'sdk';
import { ALIASES } from './booru.js';

// Служебные/технические теги — в очередь не добавляем.
const BLOCKED = new Set([
  'highres', 'absurdres', 'absurd_res', 'lowres', 'huge_filesize', 'long_image', 'tall_image',
  'wide_image', 'monochrome', 'greyscale', 'commentary', 'commentary_request', 'translated',
  'hard_translated', 'request', 'official_art', 'dupe', 'md5_mismatch', 'bad_id',
  'bad_twitter_id', 'bad_pixiv_id', 'bad_link', 'expired', 'deleted', 'name', 'character',
]);
const MAX_TAG_LEN = 32;

// Тег годится в очередь: не служебный, без уточнений в скобках, нормальной длины.
function crawlableTag(t) {
  return !BLOCKED.has(t) && !t.includes('(') && t.length <= MAX_TAG_LEN;
}
const POOL_CAP = 800;

// Стартовый набор — сеяные теги (приоритет 10).
const SEED_TAGS = [
  '1girl', '2girls', 'cat', 'dog', 'wolf', 'fox', 'anime', 'landscape', 'city', 'nature',
  'sunset', 'beach', 'snow', 'space', 'dragon', 'elf', 'maid', 'kimono', 'armor', 'magic',
  'school_uniform', 'animal_ears', 'long_hair', 'blue_eyes', 'twintails', 'cherry_blossoms',
  'underwater', 'sword', 'rain', 'night_sky',
];

export async function seedIfEmpty() {
  const { n } = await db.get('SELECT count(*) AS n FROM crawl_queue');
  if (n) return;
  const ph = SEED_TAGS.map((_, i) => `(:t${i}, 10)`).join(',');
  await db.run(
    `INSERT INTO crawl_queue(tag, priority) VALUES ${ph} ON CONFLICT DO NOTHING`,
    Object.fromEntries(SEED_TAGS.map((t, i) => [`:t${i}`, t])),
  );
}

// Атомарный захват тика по именованному слоту (сайт или '_tick'/'_file'):
// пропускает не чаще раза в minIntervalSec (гонки не бывает).
export async function claimTick(site, minIntervalSec) {
  const r = await db.run(
    `INSERT INTO crawl_state(site, last_at) VALUES (:s, unixepoch())
     ON CONFLICT(site) DO UPDATE SET last_at = unixepoch()
     WHERE unixepoch() - crawl_state.last_at >= :i`,
    { ':s': site, ':i': minIntervalSec },
  );
  return r.rowsAffected > 0;
}

// Следующий тег: приоритет со старением — крауленный тег остывает ~за час, очередь
// не голодает по приоритетам. Некрауленный (last_at NULL) не стареет вовсе — иначе
// каждый свежий спрос-тег обгонял бы предыдущего, и старые голодали; при равных
// очках первым идёт дольше всех ждущий (FIFO спроса, LRU по краулам).
export async function nextTag() {
  return db.get(
    `SELECT tag, priority, page FROM crawl_queue
     ORDER BY (priority - COALESCE((unixepoch() - last_at) / 3600.0, 0)) DESC,
              COALESCE(last_at, added_at) ASC
     LIMIT 1`,
  );
}

export async function markCrawled(tag, priority, oldPage, gotPosts) {
  // пустой результат — понижаем и сбрасываем на 1-ю страницу, иначе пилим пустые страницы
  const prio = gotPosts ? priority : Math.max(1, priority - 2);
  const page = gotPosts ? Math.min(oldPage + 1, 100) : 1;
  // пул не должен заполняться мусором навсегда: пустой краул на дне приоритетов — удаляем тег
  if (!gotPosts && priority - 2 < 1) {
    await db.run('DELETE FROM crawl_queue WHERE tag = :t', { ':t': tag });
    return;
  }
  await db.run(
    'UPDATE crawl_queue SET last_at = unixepoch(), priority = :p, page = :pg WHERE tag = :t',
    { ':p': prio, ':pg': page, ':t': tag },
  );
}

// Сайты, которые можно краулить: у каждого свой кулдаун, берём с истёкшим —
// от самых давно не троганных. sites: [[имя, cooldownSec], ...]
export async function oldestSites(sites) {
  const rows = await db.all('SELECT site, last_at FROM crawl_state');
  // raw-методы не конвертируют ключи в camelCase — только last_at
  const last = Object.fromEntries(rows.map((r) => [r.site, r.last_at ?? 0]));
  const now = Math.floor(Date.now() / 1000);
  return sites
    .map(([s, cd]) => [s, last[s] ?? 0, cd])
    .filter(([, t, cd]) => now - t >= cd)
    .sort((a, b) => a[1] - b[1])
    .map(([s]) => s);
}

// Общий хвост сеянья: кап пула, потом insert — уже лежащие теги не трогаем. → сколько легло.
async function enqueue(tags, priority) {
  const { n } = await db.get('SELECT count(*) AS n FROM crawl_queue');
  if (n >= POOL_CAP) return 0;
  const ph = tags.map((_, i) => `(:t${i}, :p)`).join(',');
  const r = await db.run(
    `INSERT INTO crawl_queue(tag, priority) VALUES ${ph} ON CONFLICT(tag) DO NOTHING`,
    { ...Object.fromEntries(tags.map((t, i) => [`:t${i}`, t])), ':p': priority },
  );
  return r.rowsAffected;
}

// Расширение каталога: частые теги партии (≥3 постов) добавляем в очередь.
export async function expandFromPosts(posts, parentPriority) {
  const freq = new Map();
  for (const p of posts) {
    for (const t of p.tags) {
      if (!crawlableTag(t)) continue;
      freq.set(t, (freq.get(t) ?? 0) + 1);
    }
  }
  const good = [...freq.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t);
  if (!good.length) return 0;
  return enqueue(good, Math.max(1, parentPriority - 1));
}

// Теги из пустого поиска: пользователь спросил то, чего нет в БД — ставим наверх
// очереди (15 > сеяных 10), следующий тик скачает. Синонимы разворачиваем (спрос
// «girl» должен прийти с краула 1girl/2girls, сам `girl` на danbooru устарел),
// оригинал тоже сеем — на gelbooru-семействе это живой тег. Уже в очереди — nothing.
export async function seedDemandTags(tags) {
  // crawlableTag (для расширения каталога) не подходит: спрос-теги бывают
  // danbooru-канонами со скобками и длиннее 32 символов — senko_(sewayaki_…).
  // Короче 3 — печатающийся мусор («s», «se»): dapi матчит их подстрокой,
  // краул вернёт вагон случайного и тег навсегда залипнет с приоритетом 15.
  const good = [...new Set(tags.flatMap((t) => [t, ...(Object.hasOwn(ALIASES, t) ? ALIASES[t] : [])]))]
    .filter((t) => !t.startsWith('-') && !BLOCKED.has(t) && t.length >= 3 && t.length <= 64); // минус-теги — исключения, не сеем
  if (!good.length) return 0;
  return enqueue(good, 15);
}

// Фоновый тик из инлайн-запроса: сам тик атомарно захватывает слот, ошибки глотаем.
export async function maybeTick(runTick) {
  try {
    await runTick();
  } catch (e) {
    console.log('maybeTick skipped:', e.message ?? e);
  }
}

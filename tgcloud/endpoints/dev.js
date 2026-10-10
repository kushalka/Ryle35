// endpoints/dev.js — dev-only: сидирует демо-посты (идемпотентно) и возвращает
// то, что инлайн отдал бы на input.query (input.offset — как у Telegram).
// Проверка: npx tgcloud run endpoints/dev '{"query":"cat"}'
// Удалить перед релизом.
import { db, fetch } from 'sdk';
import { upsertPost, buildResults, bumpPost } from '../lib/booru.js';
import { correctTags, rawVotes } from '../lib/suggest.js';
import { sankaku } from '../lib/keys.js';

const UAD = 'Ryle35InlineBot/1.0 (Telegram inline bot)';

const DEMO = [
  { remoteId: '1', fileUrl: 'https://picsum.photos/seed/cat1/800/600.jpg', fileExt: 'jpg', width: 800, height: 600, tags: ['cat'] },
  { remoteId: '2', fileUrl: 'https://picsum.photos/seed/cat2/600/800.jpg', fileExt: 'jpg', width: 600, height: 800, tags: ['cat', 'dog'] },
  { remoteId: '3', fileUrl: 'https://picsum.photos/seed/dog1/800/600.jpg', fileExt: 'jpg', width: 800, height: 600, tags: ['dog'] },
];

export default async function (input) {
  if (input.probe) return { setTimeout: typeof setTimeout }; // есть ли таймеры в изоляте
  // проба сети из облака (TG-egress): что отвечает URL без наших прокси
  if (input.probeFetch) {
    const r = await fetch(String(input.probeFetch), { headers: { 'user-agent': input.ua || UAD } });
    const t = await r.text();
    return { status: r.status, head: t.slice(0, 300) };
  }
  // проба sankaku из облака с сессией из keys.js (input.probeSankaku = тег)
  if (input.probeSankaku) {
    const r = await fetch(`https://capi-v2.sankakucomplex.com/posts?lang=en&page=1&limit=${input.limit ?? 5}&tags=${encodeURIComponent(String(input.probeSankaku))}`,
      { headers: { 'user-agent': UAD, authorization: `Bearer ${sankaku.bearer}`, cookie: sankaku.cookie } });
    const t = await r.text();
    let j = null;
    try { j = JSON.parse(t); } catch { /* не JSON — отдадим head */ }
    if (!j?.data) return { status: r.status, head: t.slice(0, 200) };
    const p = j.data[0] ?? {};
    return {
      status: r.status, n: j.data.length,
      first: p && { id: p.id, file_url: p.file_url, preview_url: p.preview_url, file_size: p.file_size, width: p.width, height: p.height, md5: p.md5, status: p.status },
      tags: (p.tags ?? []).slice(0, 5).map((x) => x.name_en ?? x.name),
    };
  }
  // лёгкий счётчик: полный count(*) по post_tags (~1М строк) вылезает за rows_read
  if (input.count) {
    const [p, q, pt] = await Promise.all([
      db.get('SELECT count(*) AS n FROM posts'),
      db.get('SELECT count(*) AS n FROM crawl_queue'),
      db.get('SELECT max(rowid) AS n FROM post_tags'),
    ]);
    return { posts: p.n, postTagsApprox: pt.n, queue: q.n };
  }
  // голосование автодополнений по одному слову (input.suggest = 'senke')
  if (input.suggest) return await correctTags([String(input.suggest)]);
  if (input.rawSuggest) return await rawVotes(String(input.rawSuggest));
  // какие теги лежат от постов конкретного сайта (input.siteTags = 'rule34.world')
  if (input.siteTags) {
    return await db.all(
      `SELECT pt.tag, count(*) AS n FROM post_tags pt JOIN posts p ON p.id = pt.post_id
       WHERE p.site = :s GROUP BY pt.tag ORDER BY n DESC`,
      { ':s': String(input.siteTags) },
    );
  }
  // разовая зачистка AI-контента (input.purgeAi): посты с AI-тегами + целиком-AI
  // сайты (aibooru, e6ai). Новое не индексируется — фильтр isAiTag в endpoints/crawl.js.
  // Токены = AI_TAGS из crawl.js ± варианты написания (в БД теги хранятся как на
  // сайте: и «ai-generated», и «ai_generated»); голый `ai` покрывает и philomena,
  // где «ai generated» разрезался на два токена — пары ловить не нужно.
  if (input.purgeAi) {
    const toks = ['ai', 'ai_art', 'ai-art', 'ai_generated', 'ai-generated', 'aigenerated',
      'ai_assisted', 'ai-created', 'ai_content', 'ai-content', 'ai_created', 'ai-created',
      'artificial_intelligence', 'stable_diffusion', 'stable-diffusion', 'novelai',
      'nai_diffusion', 'nai-diffusion', 'midjourney', 'dall_e', 'dall-e', 'civitai'];
    const ph = toks.map((_, i) => `:t${i}`).join(',');
    const tagParams = Object.fromEntries(toks.map((t, i) => [`:t${i}`, t]));
    const [byTag, bySite] = await Promise.all([
      db.all(`SELECT DISTINCT post_id AS id FROM post_tags WHERE tag IN (${ph})`, tagParams),
      db.all(`SELECT id FROM posts WHERE site IN ('aibooru.online', 'e6ai.net')`),
    ]);
    const ids = [...new Set([...byTag, ...bySite].map((r) => r.id))];
    const delIds = async (chunk) => {
      const p = chunk.map((_, j) => `:id${j}`).join(',');
      const params = Object.fromEntries(chunk.map((id, j) => [`:id${j}`, id]));
      const r = await db.run(`DELETE FROM post_tags WHERE post_id IN (${p})`, params);
      await db.run(`DELETE FROM posts WHERE id IN (${p})`, params);
      return r.rowsAffected;
    };
    // ponytail: лимит rows_written на запрос у платформы не задокументирован —
    // чанк адаптивный: отказ режет его вдвое, тот же кусок переписывается заново
    let size = 40, tagRows = 0, i = 0;
    while (i < ids.length) {
      const chunk = ids.slice(i, i + size);
      try {
        tagRows += await delIds(chunk);
        i += chunk.length;
      } catch (e) {
        if (!/rows_written/i.test(String(e.message ?? e)) || chunk.length === 1) throw e;
        size = Math.max(1, Math.floor(size / 2));
      }
    }
    const q = await db.run(`DELETE FROM crawl_queue WHERE tag IN (${ph})`, tagParams);
    const left = await db.get(`SELECT count(*) AS n FROM post_tags WHERE tag IN (${ph})`, tagParams);
    return { removedPosts: ids.length, tagRows, queueRows: q.rowsAffected, aiTagRowsLeft: left.n };
  }
  // зачистка отравленной выдачи rule34.world: неизвестный сайту тег он игнорировал
  // и отдавал случайные посты (input.wipe = { site, tag })
  if (input.wipe) {
    const { site, tag } = input.wipe;
    const r1 = await db.run(
      'DELETE FROM post_tags WHERE tag = :t AND post_id IN (SELECT id FROM posts WHERE site = :s)',
      { ':s': site, ':t': tag },
    );
    const r2 = await db.run(
      'DELETE FROM posts WHERE site = :s AND NOT EXISTS (SELECT 1 FROM post_tags pt WHERE pt.post_id = posts.id)',
      { ':s': site },
    );
    return { tags: r1.rowsAffected, posts: r2.rowsAffected };
  }
  if (input.diag) {
    return { state: await db.all("SELECT site, last_at, unixepoch() AS now FROM crawl_state WHERE site = '_tick'") };
  }
  // разовая диагностика: почему тег X в инлайне пустой/маленький (input.diagTag)
  if (input.diagTag) {
    const t = String(input.diagTag);
    const [total, playable, inQueue, stats] = await Promise.all([
      db.get("SELECT count(*) AS n FROM post_tags WHERE tag = :t", { ':t': t }),
      db.get("SELECT count(*) AS n FROM post_tags pt JOIN posts p ON p.id = pt.post_id WHERE pt.tag = :t AND p.file_ext IN ('jpg','jpeg','png','webp','gif','mp4')", { ':t': t }),
      db.get("SELECT tag, priority, page FROM crawl_queue WHERE tag = :t", { ':t': t }),
      db.get(`SELECT (SELECT count(*) FROM posts) AS posts, (SELECT count(*) FROM post_tags) AS post_tags,
              (SELECT count(*) FROM crawl_queue) AS queue, (SELECT count(*) FROM posts WHERE file_ext = 'mp4') AS mp4,
              (SELECT count(*) FROM posts WHERE file_ext = 'mp4' AND file_id IS NOT NULL) AS with_fid,
              (SELECT count(*) FROM posts WHERE file_ext = 'mp4' AND file_id IS NULL AND file_kind IS NULL
                 AND file_size BETWEEN 1000001 AND 29000000) AS backlog`),
    ]);
    const exts = await db.all(
      "SELECT p.file_ext, count(*) AS n, sum(p.thumb_url IS NOT NULL) AS with_thumb FROM post_tags pt JOIN posts p ON p.id = pt.post_id WHERE pt.tag = :t GROUP BY p.file_ext ORDER BY n DESC",
      { ':t': t },
    );
    return { tag: t, total: total.n, playable: playable.n, inQueue: inQueue ?? null, exts, stats };
  }
  // разовый фикс для тестов: проставить размер поста (input.fix = { id, size })
  if (input.fix) {
    const r = await db.run('UPDATE posts SET file_size = :s WHERE id = :id', { ':s': input.fix.size ?? null, ':id': input.fix.id });
    return { fixed: r.rowsAffected };
  }
  if (input.seed !== false) {
    for (const d of DEMO) {
      await upsertPost({ site: 'demo', ...d });
    }
  }
  const out = await buildResults(input.query ?? '', input.offset ?? '0');
  return { ids: out.results.map((r) => r.id), ...out };
}

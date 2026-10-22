// endpoints/dev.js — read-only диагностика прод-БД из облака; деструктива и сидов
// нет (эндпоинт доступен любому пользователю мини-аппа с валидным initData).
// Примеры проверки:
//   npx tgcloud run endpoints/dev '{}'                          — что инлайн отдал бы на пустой запрос
//   npx tgcloud run endpoints/dev '{"query":"cat"}'             — выдача инлайна (offset — как у Telegram)
//   npx tgcloud run endpoints/dev '{"count":1}'                 — счётчики постов/очереди
//   npx tgcloud run endpoints/dev '{"suggest":"senke"}'         — голосование автодополнений
//   npx tgcloud run endpoints/dev '{"rawSuggest":"senke"}'      — сырые ответы сайтов-автодополнений
//   npx tgcloud run endpoints/dev '{"siteTags":"rule34.world"}' — теги от постов сайта
//   npx tgcloud run endpoints/dev '{"diag":1}'                  — состояние тика
//   npx tgcloud run endpoints/dev '{"diagTag":"senko"}'         — почему тег в инлайне пустой/маленький
//   npx tgcloud run endpoints/dev '{"cache":1}'                 — размер ru_qcache и окно его жизни
import { db } from 'sdk';
import { buildFromQuery } from '../lib/booru.js';
import { correctTags, rawVotes } from '../lib/suggest.js';

export default async function (input) {
  if (input.probe) return { setTimeout: typeof setTimeout }; // есть ли таймеры в изоляте
  // лёгкий счётчик: полный count(*) по post_tags (~1М строк) вылезает за rows_read
  if (input.count) {
    const [p, q, pt] = await Promise.all([
      db.get('SELECT count(*) AS n FROM posts'),
      db.get('SELECT count(*) AS n FROM crawl_queue'),
      db.get('SELECT max(rowid) AS n FROM post_tags'),
    ]);
    return { posts: p.n, postTagsApprox: pt.n, queue: q.n };
  }
  // гигиена кэшей: размер ru_qcache и окно его жизни (input.cache).
  // count(*) тут безопасен (таблица на порядки меньше post_tags), а полный
  // sum(length(...)) вылезает за rows_read — размер считаем по выборке.
  if (input.cache) {
    const [n, span] = await Promise.all([
      db.get('SELECT count(*) AS n FROM ru_qcache'),
      db.get('SELECT min(at) AS oldest, max(at) AS newest FROM ru_qcache'),
    ]);
    const sample = await db.all(
      'SELECT length(q) + length(tags) AS b FROM ru_qcache ORDER BY rowid DESC LIMIT 200',
    );
    const avg = sample.length
      ? Math.round(sample.reduce((s, r) => s + (Number(r.b) || 0), 0) / sample.length)
      : 0;
    return {
      cache: {
        rows: n.n,
        avgRowBytes: avg,
        estBytes: n.n * avg,
        oldestAt: span?.oldest ?? null,
        newestAt: span?.newest ?? null,
        now: Date.now(),
      },
    };
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
  if (input.diag) {
    return { state: await db.all("SELECT site, last_at, unixepoch() AS now FROM crawl_state WHERE site = '_tick'") };
  }
  // разовая диагностика: почему тег X в инлайне пустой/маленький (input.diagTag)
  if (input.diagTag) {
    const t = String(input.diagTag);
    const [total, playable, inQueue, stats] = await Promise.all([
      // max(rowid) вместо count(*) — полный скан post_tags вылезает за rows_read (см. count)
      db.get("SELECT max(rowid) AS n FROM post_tags"),
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
  const out = await buildFromQuery(input.query ?? '', input.offset ?? '0');
  return { ids: out.results.map((r) => r.id), ...out };
}

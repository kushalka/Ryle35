// временный модуль для диагностики rule34.world (не деплоить, удалить после)
import { db } from 'sdk';

export default async function () {
  const [bySite, state, tagRows, recent] = await Promise.all([
    db.all(`SELECT site, count(*) AS n, sum(file_ext = 'mp4') AS mp4,
                   sum(hits) AS hits, max(created_at) AS last_add
            FROM posts GROUP BY site ORDER BY n DESC`),
    db.all(`SELECT site, last_at, unixepoch() AS now FROM crawl_state ORDER BY last_at DESC`),
    db.get(`SELECT count(*) AS n FROM post_tags pt JOIN posts p ON p.id = pt.post_id WHERE p.site = 'rule34.world'`),
    db.get(`SELECT count(*) AS n FROM posts WHERE site = 'rule34.world' AND created_at > unixepoch() - 86400`),
  ]);
  return { bySite, state, r34worldTagRows: tagRows.n, r34worldLast24h: recent.n };
}

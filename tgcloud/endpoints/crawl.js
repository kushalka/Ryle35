// endpoints/crawl.js — наполняет БД постами с боору-API (быстрые ссылки для инлайна).
// Запуск: npx tgcloud run endpoints/crawl '{"tags":"girl"}'  (sites/limit — опционально)
// Снаружи платформа пускает только с валидным initData (иначе 401).
// Учтённые причуды: danbooru — массив; e621 — {posts} с вложенными file/preview/tags;
// dapi — массив | {post} | строка-ошибка с HTTP 200; dapi-auth (gelbooru/rule34) и wallhaven —
// ключи из lib/keys.js; danbooru тег `girl` устарел (канон `1girl`);
// rule34.world — свой API: POST-поиск, выдача без тегов и ссылок (шаблон CDN), максимум 3 тега;
// dapiXml (tbib/mspa) — ссылки только в XML-режиме; shimmie (paheal) — XML, file_url без
// расширения (реальное в file_name); philomena — per_page≤50; sankaku не подключён (токен истёк).

import { upsertPost, parseTags } from '../lib/booru.js';
import { gelbooru, rule34xxx, wallhaven } from '../lib/keys.js';
import { fetch } from 'sdk';

const UA = 'Ryle35InlineBot/1.0 (Telegram inline bot)';

// cd — индивидуальный кулдаун сайта в секундах (см. лимиты API); тик берёт сайты с истёкшим cd.
// fmt: danbooru (/posts.json, массив) | e621 (/posts.json, {posts}) | dapi (gelbooru 0.2, JSON)
// | dapiXml (gelbooru 0.1, ссылки только в XML) | moebooru (/post.json) | wallhaven
// | r34world (свой POST /api/v2) | shimmie (/api/danbooru/find_posts, XML) | philomena
export const SITES = {
  'danbooru.donmai.us': { cd: 300, fmt: 'danbooru',   base: 'https://danbooru.donmai.us' },
  'safebooru.donmai.us':{ cd: 600, fmt: 'danbooru',   base: 'https://safebooru.donmai.us' },
  'e621.net':           { cd: 600, fmt: 'e621',       base: 'https://e621.net' },
  // aibooru.online и e6ai.net исключены (2026-10-10): целиком AI-генерация —
  // владелец просил, чтобы AI-контент в бота не приходил вообще.
  // e926 (SFW-e621) не добавлен: 403 на egress Telegram; hypnohub — dapi отдаёт 0 на любой тег
  'rule34.xxx':         { cd: 600, fmt: 'dapi',       base: 'https://api.rule34.xxx', auth: rule34xxx },
  'gelbooru.com':       { cd: 600, fmt: 'dapi',       base: 'https://gelbooru.com', auth: gelbooru },
  'safebooru.org':      { cd: 600, fmt: 'dapi',       base: 'https://safebooru.org' },
  'xbooru.com':         { cd: 900, fmt: 'dapi',       base: 'https://xbooru.com' },
  'tbib.org':           { cd: 900, fmt: 'dapiXml',    base: 'https://tbib.org' },
  'mspabooru.com':      { cd: 1800, fmt: 'dapiXml',    base: 'https://mspabooru.com' },
  'konachan.com':       { cd: 600, fmt: 'moebooru',   base: 'https://konachan.com' },
  'konachan.net':       { cd: 900, fmt: 'moebooru',   base: 'https://konachan.net' },
  'yande.re':           { cd: 600, fmt: 'moebooru',   base: 'https://yande.re' },
  'sakugabooru.com':    { cd: 1200, fmt: 'moebooru',   base: 'https://www.sakugabooru.com' },
  'wallhaven.cc':       { cd: 600, fmt: 'wallhaven',  base: 'https://wallhaven.cc', auth: wallhaven },
  'rule34.world':       { cd: 900, fmt: 'r34world',   base: 'https://rule34.world' },
  'rule34.paheal.net':  { cd: 900, fmt: 'shimmie',    base: 'https://rule34.paheal.net' },
  'derpibooru.org':     { cd: 600, fmt: 'philomena',  base: 'https://derpibooru.org' },
  'manebooru.org':      { cd: 900, fmt: 'philomena',  base: 'https://manebooru.org' },
  // twibooru не добавлен: сайт жив, но API закрыт (все /api/* — 404)
  'ponybooru.org':      { cd: 1200, fmt: 'philomena',  base: 'https://ponybooru.org' },
  'furbooru.org':       { cd: 1200, fmt: 'philomena',  base: 'https://furbooru.org' },
  'ponerpics.org':      { cd: 900, fmt: 'philomena',  base: 'https://ponerpics.org' },
};

const CAP = { danbooru: 200, e621: 320, dapi: 1000, moebooru: 100, wallhaven: 64, r34world: 100, shimmie: 100, philomena: 50 };

// AI-генерация не индексируется вовсе (владелец, 2026-10-10). Зонтичные теги
// боору («ai generated», «ai-generated», «ai_generated» — разделители нормализуем)
// плюс известные модельные — страховка для сайтов, где зонтик не обязателен.
// Голый `ai` — маркер wallhaven; персонажей с тегом ровно `ai` почти нет
// (ai_hoshino — другой, составной тег). ponytail: список ручной, полнота не
// гарантирована; новые umbrella-теги дописывать сюда.
const AI_TAGS = new Set([
  'ai', 'ai_generated', 'aigenerated', 'ai_assisted', 'ai_created', 'ai_content',
  'ai_art', 'artificial_intelligence',
  'stable_diffusion', 'novelai', 'nai_diffusion', 'midjourney', 'dall_e', 'civitai',
]);
const isAiTag = (t) => AI_TAGS.has(String(t).toLowerCase().replace(/[\s-]+/g, '_'));

function extOf(url) {
  return (String(url).match(/\.([a-z0-9]+)(?:\?|$)/i)?.[1] ?? 'jpg').toLowerCase();
}

async function getText(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function getJson(url) {
  const t = await getText(url);
  if (!t.trim()) return null; // некоторые dapi отвечают 200 и 0 байт
  const j = JSON.parse(t);
  if (typeof j === 'string') throw new Error(j.slice(0, 100)); // dapi отдаёт текст ошибки с кодом 200
  return j;
}

// XML-атрибуты самозакрытого тега <post .../>: dapiXml/shimmie отдают ссылки только так;
// кавычки бывают и одинарные (paheal), и двойные (tbib)
function xmlAttrs(tag) {
  const dec = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return Object.fromEntries([...tag.matchAll(/([a-zA-Z_]+)=("[^"]*"|'[^']*')/g)]
    .map((m) => [m[1], dec(m[2].slice(1, -1))]));
}

function xmlPosts(xml) {
  if (/<html[\s>]/i.test(xml)) throw new Error('HTML вместо XML (антибот?)');
  // `>` может сидеть внутри значения атрибута (тег «>_<») — не останавливаемся на нём
  return [...xml.matchAll(/<post\b(?:"[^"]*"|'[^']*'|[^>"'])*>/g)].map((m) => xmlAttrs(m[0]));
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'user-agent': UA, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const fetchers = {
  async danbooru(cfg, tags, limit, page) {
    const j = await getJson(`${cfg.base}/posts.json?tags=${encodeURIComponent(tags)}&limit=${Math.min(limit, CAP.danbooru)}&page=${page}`);
    const rows = Array.isArray(j) ? j : [];
    return rows.map((p) => p.file_url && ({
      remoteId: p.id, fileUrl: p.file_url, thumbUrl: p.preview_file_url || p.large_file_url,
      fileExt: p.file_ext || extOf(p.file_url), width: p.image_width, height: p.image_height,
      size: p.file_size,
      hash: p.md5,
      tags: (p.tag_string || '').split(' '),
    })).filter(Boolean);
  },
  async e621(cfg, tags, limit, page) {
    const j = await getJson(`${cfg.base}/posts.json?tags=${encodeURIComponent(tags)}&limit=${Math.min(limit, CAP.e621)}&page=${page}`);
    const rows = Array.isArray(j) ? j : Array.isArray(j?.posts) ? j.posts : [];
    return rows.map((p) => p.file?.url && ({
      remoteId: p.id, fileUrl: p.file.url, thumbUrl: p.preview?.url,
      fileExt: p.file.ext || extOf(p.file.url), width: p.file.width, height: p.file.height,
      size: p.file.size,
      hash: p.file.md5,
      tags: Object.values(p.tags ?? {}).flat(),
    })).filter(Boolean);
  },
  async dapi(cfg, tags, limit, page) {
    const auth = cfg.auth ? `&user_id=${cfg.auth.userId}&api_key=${cfg.auth.apiKey}` : '';
    // pid у dapi 0-индексирован (0 — самое свежее окно), очередь же начинает с 1
    const j = await getJson(`${cfg.base}/index.php?page=dapi&s=post&q=index&json=1&tags=${encodeURIComponent(tags)}&limit=${Math.min(limit, CAP.dapi)}&pid=${page - 1}${auth}`);
    const rows = Array.isArray(j) ? j : Array.isArray(j?.post) ? j.post : j?.post ? [j.post] : [];
    return rows.map((p) => p.file_url && ({
      remoteId: p.id, fileUrl: p.file_url, thumbUrl: p.preview_url,
      fileExt: extOf(p.image || p.file_url), width: Number(p.width) || null, height: Number(p.height) || null,
      size: Number(p.file_size) || null,
      hash: p.hash,
      tags: (p.tags || '').split(' '),
    })).filter(Boolean);
  },
  async moebooru(cfg, tags, limit, page) {
    const rows = await getJson(`${cfg.base}/post.json?tags=${encodeURIComponent(tags)}&limit=${Math.min(limit, CAP.moebooru)}&page=${page}`);
    return (rows ?? []).map((p) => p.file_url && ({
      remoteId: p.id, fileUrl: p.file_url, thumbUrl: p.preview_url,
      fileExt: p.file_ext || extOf(p.file_url), width: p.width, height: p.height,
      size: Number(p.file_size) || null,
      hash: p.md5,
      tags: (p.tags || '').split(' '),
    })).filter(Boolean);
  },
  async wallhaven(cfg, tags, limit, page) {
    const j = await getJson(`${cfg.base}/api/v1/search?q=${encodeURIComponent(tags)}&categories=111&purity=111&apikey=${cfg.auth.apiKey}&limit=${Math.min(limit, CAP.wallhaven)}&page=${page}`);
    return (j?.data ?? []).map((p) => p.path && ({
      remoteId: p.id, fileUrl: p.path, thumbUrl: p.thumbs?.small,
      fileExt: extOf(p.path), width: p.dimension_x, height: p.dimension_y,
      tags: (p.tags ?? []).map((t) => t.name),
    })).filter(Boolean);
  },
  async dapiXml(cfg, tags, limit, page) {
    // gelbooru 0.1 без json=1 — file_url/preview_url есть только в XML
    // pid у dapi 0-индексирован (0 — самое свежее окно), очередь же начинает с 1
    const xml = await getText(`${cfg.base}/index.php?page=dapi&s=post&q=index&tags=${encodeURIComponent(tags)}&limit=${Math.min(limit, CAP.dapi)}&pid=${page - 1}`);
    return xmlPosts(xml).map((p) => p.file_url && ({
      remoteId: p.id, fileUrl: p.file_url, thumbUrl: p.preview_url,
      fileExt: extOf(p.file_url), width: Number(p.width) || null, height: Number(p.height) || null,
      size: Number(p.file_size) || null,
      hash: p.hash,
      tags: (p.tags || '').split(' '),
    })).filter(Boolean);
  },
  async shimmie(cfg, tags, limit, page) {
    const xml = await getText(`${cfg.base}/api/danbooru/find_posts?tags=${encodeURIComponent(tags)}&limit=${Math.min(limit, CAP.shimmie)}&page=${page}`);
    return xmlPosts(xml).map((p) => p.file_url && ({
      remoteId: p.id, fileUrl: p.file_url, thumbUrl: p.preview_url,
      fileExt: extOf(p.file_name || p.file_url), // у paheal file_url без расширения
      size: Number(p.file_size) || null,
      hash: p.hash,
      width: Number(p.width) || null, height: Number(p.height) || null,
      tags: (p.tags || '').split(' '),
    })).filter(Boolean);
  },
  async philomena(cfg, tags, limit, page) {
    const j = await getJson(`${cfg.base}/api/v1/json/search/images?q=${encodeURIComponent(tags)}&per_page=${Math.min(limit, CAP.philomena)}&page=${page}`);
    return (j?.images ?? []).map((p) => p.view_url && ({
      remoteId: p.id, fileUrl: p.view_url, thumbUrl: p.representations?.thumb,
      fileExt: p.format || extOf(p.view_url), width: p.width, height: p.height,
      size: Number(p.size ?? p.file_size) || null,
      hash: p.sha512_hash,
      tags: p.tags ?? [],
    })).filter(Boolean);
  },
  async r34world(cfg, tags, limit, page) {
    // страницы — cursor-walk: hops-1 прыжков по окну limit, последнее окно итогово.
    // Сервер молча игнорит неизвестные теги и берёт максимум 3 — при запросе с
    // опечатанным тегом выдача = просто «свежее», нерелевантна. Лечится эхо-проверкой:
    // GET /post/<id первого> и сверка его тегов с запросом (у сайта теги с пробелами).
    const include = tags.split(' ').filter(Boolean).slice(0, 3);
    const take = Math.min(limit, CAP.r34world);
    const rows = [];
    let cursor;
    // ponytail: потолок глубины 3 — страницей очереди глубже этот сайт всё равно
    // не влезает в ~20с вызова платформы, а зависший тик убивает работу всей очереди
    const hops = Math.min(page, 3);
    for (let hop = 0; hop < hops; hop++) {
      const j = await postJson(`${cfg.base}/api/v2/post/search/root`, {
        includeTags: include,
        take,
        ...(cursor ? { cursor } : {}),
      });
      const items = j?.items ?? [];
      if (!items.length) break;
      if (hop === hops - 1) { rows.push(...items); break; }
      cursor = j.cursor;
      if (!cursor) break;
    }
    // эхо-проверка: незнакомый тег сервер молча игнорит и отдаёт «просто свежее» —
    // сверяем теги первого поста (там значения с пробелами); нашего тега нет ⇒ мусор
    if (rows.length && include.length) {
      const one = await getJson(`${cfg.base}/api/v2/post/${rows[0].id}`);
      const has = (one?.tags ?? []).some((t) => include.includes(String(t.value).replace(/\s+/g, '_').toLowerCase()));
      if (!has) {
        console.log(`${cfg.base}: tag echo miss [${include}] — batch dropped`);
        return [];
      }
    }
    return rows.map((p) => ({
      remoteId: p.id,
      fileUrl: `https://rule34storage.b-cdn.net/posts/${p.id}/1000/${p.id}.${p.type === 1 ? 'mov.mp4' : 'pic.jpg'}`,
      thumbUrl: `https://rule34storage.b-cdn.net/posts/${p.id}/1000/${p.id}.pic256.jpg`,
      fileExt: p.type === 1 ? 'mp4' : 'jpg', // хэша у API нет — дедуп не задетектит
      // hash: null,
      width: p.width, height: p.height,
      tags: include, // своих тегов API не отдаёт — ровно то, что сайт сматчил (≤3)
    }));
  },
};

// → { tags: [...], sites: [{ site, total | error }] }
export default async function crawl({ tags, limit = 100, sites, page = 1, collect = false } = {}) {
  const q = parseTags(Array.isArray(tags) ? tags.join(' ') : typeof tags === 'string' ? tags : '');
  const query = q.join(' ');
  const chosen = sites?.length
    ? Object.fromEntries(sites.map((s) => [s, SITES[s]]))
    : SITES;
  const allPosts = [];
  // Фетч параллельно (хосты разные, тик = самый медленный сайт, а не сумма).
  const fetched = await Promise.all(Object.entries(chosen).map(async ([site, cfg]) => {
    if (!cfg) return { site, error: 'unknown site' };
    try {
      // посты без собственных тегов (wallhaven, xml с пустым tags) получают теги запроса,
      // иначе их никто не найдёт
      const posts = (await fetchers[cfg.fmt](cfg, query, limit, page))
        .map((p) => {
          const own = p.tags.filter(Boolean);
          return { ...p, tags: own.length ? own : q };
        })
        .filter((p) => p.tags.length && !p.tags.some(isAiTag));
      return { site, posts };
    } catch (e) {
      // в message может прилететь полный URL с api_key — query режем
      return { site, error: String(e.message || e).replace(/\?[^ ]*/, '?…') };
    }
  }));
  // Апсерты строго последовательно: параллельные ломают md5-дедуп — два сайта
  // с одним файлом оба пройдут twin-проверку и вставят дубликат.
  const out = [];
  for (const f of fetched) {
    if (f.error) {
      out.push({ site: f.site, error: f.error });
      console.log(`${f.site}: ERROR ${f.error}`);
      continue;
    }
    let dups = 0;
    for (const p of f.posts) {
      const r = await upsertPost({ site: f.site, ...p });
      if (r.dup) dups++;
    }
    if (collect) allPosts.push(...f.posts);
    out.push({ site: f.site, total: f.posts.length, dups });
    console.log(`${f.site}: ${f.posts.length} (${dups} dup)`);
  }
  return { tags: q, sites: out, ...(collect ? { posts: allPosts } : {}) };
}

// endpoints/crawl.js — наполняет БД постами с боору-API (быстрые ссылки для инлайна).
// Запуск: npx tgcloud run endpoints/crawl '{"tags":"girl"}'  (sites/limit — опционально)
// Снаружи платформа пускает только с валидным initData (иначе 401).
// Учтённые причуды: danbooru — массив; e621 — {posts} с вложенными file/preview/tags;
// dapi — массив | {post} | строка-ошибка с HTTP 200; dapi-auth (gelbooru/rule34) и wallhaven —
// ключи из lib/keys.js; danbooru тег `girl` устарел (канон `1girl`);
// rule34.world — свой API: POST-поиск, выдача без тегов и ссылок (шаблон CDN), максимум 3 тега;
// dapiXml (tbib/mspa) — ссылки только в XML-режиме; shimmie (paheal) — XML, file_url без
// расширения (реальное в file_name); philomena — per_page≤50; sankaku не подключён (токен истёк).
// furaffinity — HTML-поиск; deviantart — OAuth2 /browse/tags (один тег); nhentai — v2-листинг →
// страница-1 по media_id; ehentai — HTML-поиск + gdata (обложка ehgt.org); itaku — required_tags;
// scrolller — GraphQL /admin (тег → сабреддит). Все проверены на хотлинк без Referer (требование
// инлайна ТГ); pixiv/hitomi отпали (нужен Referer), kemono/coomer — мёртвый файловый CDN.

import { upsertPost, parseTags } from '../lib/booru.js';
import { gelbooru, rule34xxx, wallhaven, deviantart } from '../lib/keys.js';
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
  // FA: API нет — HTML-поиск; файлы и превью t./d.furaffinity.net отдаёт без Referer,
  // куки не нужны (анонимная выдача general/questionable). DA: OAuth2 app-токен,
  // /browse/tags принимает ровно один «свой» тег (booru-лексика → 400 = пусто).
  'furaffinity.net':    { cd: 900, fmt: 'furaffinity', base: 'https://www.furaffinity.net' },
  'deviantart.com':     { cd: 900, fmt: 'deviantart', base: 'https://www.deviantart.com', auth: deviantart },
  // nhentai — галереи додзи (v2-API, ключ не нужен); e-hentai — галереи (gdata, без ключа);
  // itaku — арт-платформа (required_tags); scrolller — reddit-аггрегатор (GraphQL, тег→сабреддит).
  'nhentai.net':        { cd: 120, fmt: 'nhentai',    base: 'https://nhentai.net' },
  'e-hentai.org':       { cd: 600, fmt: 'ehentai',    base: 'https://e-hentai.org' },
  'itaku.ee':           { cd: 300, fmt: 'itaku',      base: 'https://itaku.ee' },
  'scrolller.com':      { cd: 900, fmt: 'scrolller',  base: 'https://api.scrolller.com/admin' },
};

const CAP = { danbooru: 200, e621: 320, dapi: 1000, moebooru: 100, wallhaven: 64, r34world: 100, shimmie: 100, philomena: 50, furaffinity: 48, deviantart: 48, nhentai: 25, ehentai: 25, itaku: 15, scrolller: 60 };

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

// DA: OAuth2 app-токен по client_credentials (scope app — только публичное).
// Живёт 1 час; кэш в модуле — изолят переиспользуется между вызовами, но на
// холодном старте токен берём заново (лишний запрос на сайт за краул).
let daToken = { value: null, exp: 0 };

async function deviantartToken(base, auth) {
  if (daToken.value && daToken.exp > Date.now() + 60000) return daToken.value;
  const res = await fetch(`${base}/oauth2/token`, {
    method: 'POST',
    headers: { 'user-agent': UA },
    body: fetch.body.form({ grant_type: 'client_credentials', client_id: auth.clientId, client_secret: auth.clientSecret }),
  });
  if (!res.ok) throw new Error(`token HTTP ${res.status}`);
  const j = await res.json();
  daToken = { value: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return daToken.value;
}

// Авторизованный JSON: у DA незнакомый тег — это 400 «Tag not found», не поломка
// сайта, поэтому такой ответ отдаём как null (пустая выдача), а не исключением.
async function getJsonAuth(url, token) {
  const res = await fetch(url, { headers: { 'user-agent': UA, authorization: `Bearer ${token}` } });
  if (res.status === 400) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
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

export const fetchers = {
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
    // CDN-путь: /posts/<бакет id/1000>/<id>/<id>.<вариант> (схема сменилась 2026-10-10,
    // старая /posts/<id>/1000/<id>... отдаёт 404 на все посты)
    return rows.map((p) => ({
      remoteId: p.id,
      fileUrl: `https://rule34storage.b-cdn.net/posts/${Math.floor(p.id / 1000)}/${p.id}/${p.id}.${p.type === 1 ? 'mov.mp4' : 'pic.jpg'}`,
      thumbUrl: `https://rule34storage.b-cdn.net/posts/${Math.floor(p.id / 1000)}/${p.id}/${p.id}.pic256.jpg`,
      fileExt: p.type === 1 ? 'mp4' : 'jpg', // хэша у API нет — дедуп не задетектит
      // hash: null,
      width: p.width, height: p.height,
      tags: include, // своих тегов API не отдаёт — ровно то, что сайт сматчил (≤3)
    }));
  },
  async furaffinity(cfg, tags, limit, page) {
    // FA — API нет, только HTML. <figure id="sid-<id>"> содержит data-tags и src
    // превью //t.furaffinity.net/<id>@<size>-<ts>.jpg (size у FA 200/300/400 — по
    // ширине окна). perpage больше 48 FA не отдаёт (120/240 → те же 48), поэтому
    // лимит режем на CAP. @600 (medium) есть у всех постов: у src@200/300 он тоже
    // 200 OK, а @1200 отдаёт 301 → @600. Превью и сам файл FA открывает без
    // Referer и без кук — ровно то, что нужно инлайну ТГ. Кук в запросе нет: анонимный
    // поиск отдаёт general/questionable, adult у FA скрыт без логина (куки владельца
    // не подставляем — сессия ловила бы «смену IP» со стороны ФА).
    const html = await getText(`${cfg.base}/search/?q=${encodeURIComponent(tags)}&perpage=${Math.min(limit, CAP.furaffinity)}&page=${page}`);
    const out = [];
    for (const m of html.matchAll(/<figure\b[^>]*>[\s\S]*?<\/figure>/g)) {
      const fig = m[0];
      const id = /id="sid-(\d+)"/.exec(fig)?.[1];
      const src = /src="((?:https?:)?\/\/t\.furaffinity\.net\/[^"]+\.jpg)"/.exec(fig)?.[1];
      if (!id || !src) continue;
      const ts = /@\d+-(\d+)\.jpg/.exec(src)?.[1];
      // FA-теги с неймспейсами (u_ юзер, c_ персонаж, s_ вид, t_ тема) + «all»
      // заглушки поисковой выдачи — префикс и заглушки срезаем, остальное как есть
      const raw = /data-tags="([^"]*)"/.exec(fig)?.[1] ?? '';
      const own = raw.split(/\s+/).map((t) => t.replace(/^[a-z]_/, ''))
        .filter((t) => t && !/^(all|unspecified_any)$/.test(t));
      // размер и исходные габариты FA в выдаче не даёт: размер NULL — для фото
      // PLAYABLE его пропускает, а @600-превью заведомо много меньше 5 МБ
      out.push({
        remoteId: id,
        fileUrl: ts ? `https://t.furaffinity.net/${id}@600-${ts}.jpg` : 'https:' + src,
        thumbUrl: 'https:' + src,
        fileExt: 'jpg',
        tags: own,
      });
    }
    return out;
  },
  async deviantart(cfg, tags, limit, page) {
    // DA: app-токен → /browse/tags. Один тег на запрос — запятая/пробел в tag дают
    // 400 «Tag not found» (мульти-тег API не умеет), поэтому берём первое слово.
    // content.src — прямая ссылка на CDN с токеном, привязанным к пути (без Referer
    // отдаётся, без токена — 401); токен app-scoped и без exp в JWT, т.е. по ссылке
    // в БД он не протухает. content.filesize — размер для лимита 5 МБ у фото,
    // thumbs[0] (150×150 fit) — превью. Своих тегов API не отдаёт: ставим ровно тот,
    // что сматчил браузер тегов (в отличие от заглушки q, лишних слов не приписываем).
    const tag = tags.split(' ').filter(Boolean)[0];
    if (!tag) return [];
    const token = await deviantartToken(cfg.base, cfg.auth);
    const take = Math.min(limit, CAP.deviantart);
    const j = await getJsonAuth(`${cfg.base}/api/v1/oauth2/browse/tags?tag=${encodeURIComponent(tag)}&limit=${take}&offset=${(page - 1) * take}`, token);
    return (j?.results ?? []).filter((p) => p.content?.src && !p.is_deleted && !p.is_blocked).map((p) => ({
      remoteId: p.deviationid,
      fileUrl: p.content.src,
      thumbUrl: p.thumbs?.[0]?.src ?? p.preview?.src,
      fileExt: extOf(p.content.src),
      width: p.content.width, height: p.content.height,
      // content.filesize — размер ОРИГИНАЛА: у ссылок с /v1/fill|fit/ DA отдаёт
      // урезанный вариант, и тот filesize завышен в разы. Там ставим NULL (fit-
      // вариант по лимитам URL заведомо <5 МБ, а PLAYABLE фото с NULL пропускает);
      // у прямых ссылок на оригинал размер точный и режет >5 МБ как надо.
      size: /\/v1\/(fill|fit)\//.test(p.content.src) ? null : (Number(p.content.filesize) || null),
      tags: [tag],
    }));
  },
  async nhentai(cfg, tags, limit, page) {
    // nhentai v2 (/api/v2): старый /api/galleries/search теперь 403 «Use new API».
    // Листинг НЕ отдаёт fileUrl — только media_id и путь превью galleries/<mid>/thumb[.<orig>].webp;
    // страница-1 лежит как 1.<orig> (thumb.jpg.webp → 1.jpg, thumb.webp → 1.webp — сверено на
    // живых галереях; зеркала i1..i4/t1..t4 отдают одинаково, хотлинк без Referer 200 image/*).
    // Аноним 10 req/мин (ловил 429) — cd 120 держит запас. Теги: tag_ids → один запрос /tags/ids.
    // Нормализация: теги nhentai — «слова через пробел», подчёркивания дают 0 результатов.
    const q = tags.split(' ').filter(Boolean).map((t) => t.replace(/_/g, ' ')).join(' ');
    const j = await getJson(`${cfg.base}/api/v2/search?query=${encodeURIComponent(q)}&page=${page}`);
    const rows = (Array.isArray(j?.result) ? j.result : []).slice(0, Math.min(limit, CAP.nhentai));
    const ids = [...new Set(rows.flatMap((p) => p.tag_ids ?? []))].slice(0, 100);
    let names = new Map();
    if (ids.length) {
      try {
        const ts = await getJson(`${cfg.base}/api/v2/tags/ids?ids=${ids.join(',')}`);
        names = new Map((ts ?? []).map((t) => [t.id, String(t.name).replace(/\s+/g, '_')]));
      } catch { /* теги не критичны — crawl подставит теги запроса */ }
    }
    return rows.map((p) => {
      const m = /^galleries\/(\d+)\/thumb(?:\.([a-z0-9]+))?\.webp$/.exec(String(p.thumbnail ?? ''));
      if (!m) return null;
      const [, mid, orig] = m;
      const ext = orig || 'webp';
      const srv = 1 + (Number(p.id) % 4); // i1..i4 / t1..t4 — зеркала, отдаёт любое
      return {
        remoteId: p.id,
        fileUrl: `https://i${srv}.nhentai.net/galleries/${mid}/1.${ext}`,
        thumbUrl: `https://t${srv}.nhentai.net/${p.thumbnail}`,
        fileExt: ext,
        // размеров/хэша в листинге нет — дедуп только по (site, remote_id)
        tags: (p.tag_ids ?? []).map((id) => names.get(id)).filter(Boolean),
      };
    }).filter(Boolean);
  },
  async ehentai(cfg, tags, limit, page) {
    // e-hentai: у api.php только gdata (method=search нет); поиск — HTML /?f_search=,
    // пагинация курсором next=<gid> (page игнорируется). Собираем пары gid/token из выдачи
    // и одним POST gdata (≤25 gid) берём метаданные/теги/обложку. fileUrl = обложка ehgt.org
    // (стабильная, хотлинк без Referer 200 image/webp); ссылку на полную страницу НЕ строим —
    // её URL живёт с keystamp и нестандартным портом hath.network и протухает, в БД держать нельзя.
    const q = tags.split(' ').filter(Boolean).map((t) => t.replace(/_/g, ' ')).join(' ');
    let html = '';
    const hops = Math.min(page, 3); // cursor-walk; глубже не влезает в тик платформы
    let url = `${cfg.base}/?f_search=${encodeURIComponent(q)}`;
    for (let hop = 0; hop < hops; hop++) {
      html = await getText(url);
      const nxt = html.match(/[?&]next=(\d+)/);
      if (hop === hops - 1 || !nxt) break;
      url = `${cfg.base}/?f_search=${encodeURIComponent(q)}&next=${nxt[1]}`;
    }
    const uniq = new Map();
    for (const m of html.matchAll(/\/g\/(\d+)\/([0-9a-f]{10})\//g)) if (!uniq.has(Number(m[1]))) uniq.set(Number(m[1]), m[2]);
    const gids = [...uniq.keys()].slice(0, Math.min(limit, CAP.ehentai));
    if (!gids.length) return [];
    const meta = await postJson('https://api.e-hentai.org/api.php',
      { method: 'gdata', gidlist: gids.map((g) => [g, uniq.get(g)]), namespace: 1 });
    return (meta?.gmetadata ?? []).filter((g) => !g.error && !g.expunged && g.thumb).map((g) => ({
      remoteId: g.gid,
      fileUrl: String(g.thumb).replace(/^http:/, 'https:'),
      thumbUrl: String(g.thumb).replace(/^http:/, 'https:'),
      fileExt: extOf(g.thumb),
      // теги с неймспейсом (language:/artist:/female:) → срезаем префикс, пробелы → _
      tags: (g.tags ?? []).map((t) => String(t).replace(/^[a-z]+:/, '').replace(/\s+/g, '_')),
    }));
  },
  async itaku(cfg, tags, limit, page) {
    // /api/posts/ — DRF cursor-пагинация: limit и page API игнорит (всегда 15 строк);
    // реальный фильтр тегов — required_tags (AND, повторяемый), а tags= сайт молча игнорит
    // (nonsense-тег даёт те же id, что и настоящий). Один пост = несколько gallery_images ⇒
    // строка на каждый файл. Для анимации живой файл только в image (image_xl битый);
    // для статики берём image_xl (≤4.2 МБ, влезает в лимит фото 5 МБ) — оригинал image часто >5 МБ.
    const req = tags.split(' ').filter(Boolean).map((t) => `&required_tags=${encodeURIComponent(t)}`).join('');
    let url = `${cfg.base}/api/posts/?limit=${Math.min(limit, CAP.itaku)}${req}`;
    const rows = [];
    const hops = Math.min(page, 2); // page >1 — проход по курсору links.next; потолок 2 прыжка
    for (let hop = 0; hop < hops; hop++) {
      const j = await getJson(url);
      rows.push(...(j?.results ?? []));
      const next = j?.links?.next;
      if (hop === hops - 1 || !next) break;
      url = next;
    }
    return rows.flatMap((p) => (p.gallery_images ?? []).map((g) => {
      const fileUrl = g.animated ? g.image : (g.image_xl || g.image);
      return {
        remoteId: g.id,
        fileUrl,
        thumbUrl: g.image_lg || g.image,
        fileExt: extOf(fileUrl),
        // габариты/вес/хэш API не отдаёт (uncompressed_filesize — только в detail-эндпоинте)
        tags: (p.tags ?? []).map((t) => t.name),
      };
    })).filter((p) => p.fileUrl);
  },
  async scrolller(cfg, tags, limit, page) {
    // cfg.base = 'https://api.scrolller.com/admin' — единственный живой GraphQL-путь
    // (/graphql → 301, /api/v2/graphql → 404). Тег (боорного нет) → searchSubreddits →
    // первые 4 саба → getSubreddit → посты. Медиа: mediaSources[] {url,width,height,type};
    // JPEG с images.scrolller.com, MP4 с octa.scrolller.com — хотлинк без Referer 200.
    const gql = async (query, variables) => {
      const res = await fetch(cfg.base, {
        method: 'POST',
        headers: { 'user-agent': UA, 'content-type': 'application/json', accept: '*/*',
                   origin: 'https://scrolller.com', referer: 'https://scrolller.com/' },
        body: JSON.stringify({ query, variables }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (j.errors && j.errors.length) throw new Error(String(j.errors[0].message).slice(0, 120));
      return j.data;
    };
    // фраза уходит как есть; isNsfw:true — иначе NSFW-сабы не находятся
    const term = String(tags).trim().split(/\s+/).slice(0, 3).join(' ') || 'nsfw';
    const s = await gql('query S($q:String!,$l:Int!,$n:Boolean!,$p:Int!){searchSubreddits(data:{query:$q,isNsfw:$n,limit:$l,pageIndex:$p}){url}}',
      { q: term, l: 4, n: true, p: Math.max(0, page - 1) });
    const subs = (s.searchSubreddits || []).map((x) => x.url).filter(Boolean).slice(0, 4);
    if (!subs.length) return [];
    const out = [];
    for (const sub of subs) {
      const d = await gql('query Q($u:String!,$l:Int!){getSubreddit(data:{url:$u,limit:$l}){children{items{id tags mediaSources{url width height type}}}}}',
        { u: sub.startsWith('/r/') ? sub : '/r/' + sub, l: Math.min(limit, CAP.scrolller) });
      for (const it of (d && d.getSubreddit ? d.getSubreddit.children.items : [])) {
        const ms = (it && it.mediaSources) || [];
        const vid = ms.find((m) => m.type === 'MP4'); // webm в инлайне не играет — берём mp4
        const pics = ms.filter((m) => m.type === 'JPEG')
          .sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));
        const src = vid || pics[0] || ms.find((m) => m.type === 'WEBP');
        if (!src || !src.url) continue;
        out.push({
          remoteId: it.id, fileUrl: src.url,
          thumbUrl: (pics.length ? pics[pics.length - 1] : src).url,
          fileExt: vid ? 'mp4' : extOf(src.url),
          width: src.width, height: src.height,
          tags: Array.isArray(it.tags) ? it.tags.filter(Boolean) : [],
        });
        if (out.length >= limit) break;
      }
      if (out.length >= limit) break;
    }
    return out;
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

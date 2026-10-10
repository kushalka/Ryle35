// lib/suggest.js — правка тега голосованием автодополнений боору-сайтов:
// опечатка/разговорное имя → тег, за который проголосовало больше всего сайтов
// (senke → senko). Все автодополнения префиксные, опечатку в хвосте не видит
// никто — при пустом ответе повторяем без последнего символа. Кандидаты-правки
// (≤2 отличий) бьют продолжения (senke → senko, а не senki_zesshou_symphogear);
// при равенстве — больше сайтов, потом больше постов.

import { fetch } from 'sdk';

const UA = 'Ryle35InlineBot/1.0 (Telegram inline bot)';
const LIMIT = 8; // подсказок с одного сайта

async function getJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const norm = (s) => String(s).replace(/\s+/g, '_').toLowerCase();

const danb = (base) => async (w) =>
  (await getJson(`${base}/autocomplete.json?search[query]=${encodeURIComponent(w)}&search[type]=tag&limit=${LIMIT}`))
    .map((t) => ({ tag: norm(t.value), count: t.post_count ?? 0 }));
const dapi = (base) => async (w) =>
  (await getJson(`${base}/autocomplete.php?q=${encodeURIComponent(w)}&limit=${LIMIT}`))
    .map((t) => ({ tag: norm(t.value), count: Number(String(t.label).match(/\((\d+)\)/)?.[1] ?? 0) }));
const moe = (base) => async (w) =>
  (await getJson(`${base}/tag.json?name=${encodeURIComponent(w)}*&order=count&limit=${LIMIT}`))
    .map((t) => ({ tag: norm(t.name), count: t.count ?? 0 }));

// Сайты с рабочими автодополнениями (нет: gelbooru — deprecated, e6ai — 404 и
// целиком AI, aibooru — тоже AI-боору, wallhaven/r34world/paheal/tbib/mspa —
// эндпоинта нет). 1 сайт = 1 голос.
const AC = {
  'danbooru.donmai.us':  danb('https://danbooru.donmai.us'),
  'safebooru.donmai.us': danb('https://safebooru.donmai.us'),
  'rule34.xxx':          dapi('https://api.rule34.xxx'),
  'safebooru.org':       dapi('https://safebooru.org'),
  'xbooru.com':          dapi('https://xbooru.com'),
  'konachan.com':        moe('https://konachan.com'),
  'konachan.net':        moe('https://konachan.net'),
  'yande.re':            moe('https://yande.re'),
  'www.sakugabooru.com': moe('https://www.sakugabooru.com'),
  'e621.net': async (w) =>
    (await getJson(`https://e621.net/tags/autocomplete.json?search[name_matches]=${encodeURIComponent(w)}*&limit=${LIMIT}`))
      .map((t) => ({ tag: norm(t.name), count: t.post_count ?? 0 })),
  'derpibooru.org': async (w) =>
    ((await getJson(`https://derpibooru.org/api/v1/json/search/tags?q=slug:${encodeURIComponent(w)}*&per_page=${LIMIT}`)).tags ?? [])
      .map((t) => ({ tag: norm(t.name), count: t.images ?? 0 })),
};

// Левенштейн; нам нужны только расстояния ≤2, дальше 2 по длине — не считаем.
function dist(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Голоса сайтов по словам: tag → { sites: Set<хостов>, pfx: Set, count }.
// pfx — сайты, давшие тег на укороченное слово (префикс-фолбэк): dapi-семейство
// матчит подстрокой (senke ⊂ senkey) и топит настоящий префикс-кандидат счётчиком,
// поэтому голос префикс-раунда весомее голоса полного. Все запросы параллельно;
// таймеров в изоляте нет — вместо таймаута кворум: не ждём по 2 зависших на слово.
async function askSites(words, votes = new Map(), short = false) {
  const tasks = [];
  for (const word of words) {
    for (const [site, fn] of Object.entries(AC)) {
      tasks.push(fn(word).then((list) => ({ site, list, short })));
    }
  }
  await new Promise((resolve) => {
    let settled = 0;
    const need = tasks.length - 2 * words.length;
    for (const t of tasks) {
      t.then(
        ({ site, list, short }) => {
          for (const c of list ?? []) {
            const v = votes.get(c.tag) ?? { sites: new Set(), pfx: new Set(), count: 0 };
            v.sites.add(site);
            if (short) v.pfx.add(site);
            v.count = Math.max(v.count, c.count);
            votes.set(c.tag, v);
          }
          if (++settled >= need) resolve();
        },
        () => { if (++settled >= need) resolve(); },
      );
    }
  });
  return votes;
}

// Отладка: ответы всех сайтов по слову с ошибками (endpoints/dev).
export async function rawVotes(word) {
  const out = {};
  await Promise.all(Object.entries(AC).map(async ([site, fn]) => {
    try { out[site] = (await fn(word)).map((c) => `${c.tag}:${c.count}`); }
    catch (e) { out[site] = `ERR ${e.message ?? e}`; }
  }));
  return out;
}

// Слово → { fix: исправленный тег, alias?: канон-продолжение для сеяния }.
// alias — danbooru-канон в скобках (senko → senko_(…)); в ПОИСК не идёт (И-запрос
// его не переживёт), находит такие посты ручной ALIASES в lib/booru.js.
// ponytail: авто-алиас в поиск не подключён — ручной ALIASES покрывает; добавить,
// когда появится таблица алиасов.
export async function suggestWord(word) {
  const votes = await askSites([word]);
  // Опечатку в хвосте («senke») префиксные автодополнения не видят: если точного
  // тега не предложил никто — спрашиваем ещё и укороченное слово («senk»).
  if (word.length > 3 && !votes.has(word)) await askSites([word.slice(0, -1)], votes, true);
  const cands = [...votes.entries()].map(([tag, v]) => ({ tag, sites: v.sites.size, pfx: v.pfx.size, count: v.count }))
    .sort((a, b) => b.pfx - a.pfx || b.sites - a.sites || b.count - a.count);
  if (!cands.length) return { fix: word };
  // alias — предпочтительно danbooru-канон в скобках (senko → senko_(…))
  const aliasOf = (of) => {
    const cs = cands.filter((c) => c.tag !== of && c.tag.startsWith(of) && c.sites >= 2);
    return cs.find((c) => c.tag.includes('('))?.tag ?? cs[0]?.tag;
  };
  if (votes.has(word)) {
    const alias = aliasOf(word);
    return { fix: word, ...(alias ? { alias } : {}) };
  }
  const pool = cands.filter((c) => dist(word, c.tag) <= 2);
  // правки нет — возьмём продолжение (senk → senki_zesshou…: пользователь недотипал)
  const cont = pool.length ? pool : cands.filter((c) => c.tag.startsWith(word));
  if (!cont.length) return { fix: word };
  const alias = aliasOf(cont[0].tag);
  return { fix: cont[0].tag, ...(alias ? { alias } : {}) };
}

// Теги запроса → { search: исправленные для поиска, seed: что сеять, changed }.
// Слова короче 3 символов — печатающийся мусор: из правки и сеяния выбрасываем.
// known — слова, уже есть в индексе: проходят как есть, без запросов к сайтам.
// Минус-тег: правим слово без знака, знак возвращаем в поиск; в сеяние минус-слова
// не идём — пользователь его исключить просил, качать его не надо.
export async function correctTags(tags, known = new Set()) {
  const neg = tags.map((t) => t.startsWith('-'));
  const bare = tags.map((t, i) => (neg[i] ? t.slice(1) : t));
  const words = bare.map((t, i) => [t, neg[i]]).filter(([t]) => t.length >= 3 && !known.has(t)).slice(0, 3);
  if (!words.length) return { search: tags, seed: tags.filter((t) => !t.startsWith('-')), changed: false };
  const out = await Promise.all(words.map(([t]) => suggestWord(t)));
  const fix = new Map(words.map(([t], i) => [t, out[i].fix]));
  const keep = bare.map((_, i) => i).filter((i) => bare[i].length >= 3);
  const search = keep.map((i) => (neg[i] ? '-' : '') + (fix.get(bare[i]) ?? bare[i]));
  return {
    search,
    seed: [...new Set(words.flatMap(([, n], i) => (n ? [] : [out[i].fix, ...(out[i].alias ? [out[i].alias] : [])])))],
    changed: search.some((t, i) => t !== tags[keep[i]]),
  };
}

// lib/booru.js — поиск постов по тегам, популярность, сборка инлайн-результатов.
// Схема: posts (посты), post_tags (тег ↔ пост).

import { db } from 'sdk';

const PAGE = 20; // Telegram показывает до 50, берём с запасом меньше
export { PAGE };

// 'Cat, dog_ears wolf' → ['cat', 'dog_ears', 'wolf']
export function parseTags(text) {
  return [...new Set((text ?? '').toLowerCase().split(/[\s,]+/).filter(Boolean))];
}

// Синонимы боору-счётных тегов: пользовательское «girl» должно находить 1girl/2girls и пр.
// Список ДОПОЛНЯЕТ оригинальное слово (оригинал жив на gelbooru-семействе), не заменяет.
// ponytail: подстрочный LIKE тут невозможен — облачная SQLite режет запрос по
// rows_read (полный скан post_tags), поэтому только индексный IN + ручные синонимы.
// (экспортируется и для seedDemandTags — сеем развёрнутые синонимы спроса).
export const ALIASES = {
  girl: ['1girl', '2girls', '3girls', '4girls', '5girls', '6+girls', 'girls', '1girls'],
  boy:  ['1boy', '2boys', '3boys', '4boys', '5boys', 'boys', '1boys'],
  cat:  ['domestic_cat'],
  dog:  ['domestic_dog'],
  // разговорное имя ≠ канон danbooru (тег-скобки): «senko» на danbooru пустой
  senko: ['senko_(sewayaki_kitsune_no_senko-san)'],
};

// webm/zip в инлайне не проигрываются — отсеиваем ещё в SQL, иначе страница
// может состоять из одних webm и вернуться пустой после фильтрации.
// Лимиты Bot API на файлы по ссылке: фото ≤5 МБ (крупный файл валит весь
// answerInlineQuery с 400 — пользователь видит ноль результатов), mp4 >20 МБ и
// gif >8 МБ ТГ молча выкидывает — не тратим на них слоты. Пост с file_id ТГ
// (filetick) отдаётся из кэша — лимит URL на него не действует (у фото file_id
// нет). NULL-размер (старые строки) пропускаем: покажутся как video-карточка
// либо отсеются ТГ; размеры добираются при ротации страниц.
const PLAYABLE = `((p.file_ext IN ('jpg','jpeg','png','webp') AND (p.file_size IS NULL OR p.file_size <= 5000000))
  OR (p.file_ext = 'gif' AND (p.file_size IS NULL OR p.file_size <= 8000000))
  OR (p.file_ext = 'mp4' AND ((p.file_id IS NOT NULL AND p.file_kind IN ('video','anim')) OR p.file_size IS NULL OR p.file_size <= 20000000)))`;

// Мёртвые файлы (filetick не смог отдать) — мимо: тап в них даёт пустое сообщение.
// Кэш ТГ (file_id) первым: играет мгновенно и вне лимитов URL (касается mp4 —
// у фото file_id нет, порядок не меняет).
const DEAD = `AND (p.file_kind IS NULL OR p.file_kind != 'dead')`;
const ORDER = `ORDER BY (p.file_id IS NOT NULL) DESC, p.hits DESC, p.id DESC`;

// Посты по тегам (все слова обязательны, каждое — точный тег или его синонимы);
// тег с минусом («-girl») наоборот исключается — вместе с синонимами;
// элемент — строка ИЛИ массив альтернатив (одно ИЛИ-условие, см. glueWords);
// без тегов — топ по популярности.
export async function searchPosts(tags, limit = PAGE, offset = 0) {
  // ponytail: чисто-минусовый запрос (-dog) — осознанная семантика владельца
  // «все посты кроме», но это скан posts; переживёт, пока posts < rows_read (~100k).
  if (tags.length) {
    const words = tags.map((slot) => {
      const arr = Array.isArray(slot) ? slot : [slot];
      const neg = arr[0].startsWith('-'); // слот однороден по знаку (см. glueWords)
      const [head, ...rest] = arr.map((t) => (neg ? t.slice(1) : t));
      // Object.hasOwn — иначе запрос «constructor» достаёт функцию из прототипа
      // и спред падает (то же в seedDemandTags)
      return { neg, set: [...new Set([head, ...rest, ...(Object.hasOwn(ALIASES, head) ? ALIASES[head] : [])])] };
    });
    const params = {};
    let n = 0;
    const conds = words.map(({ neg, set }) => {
      const ph = set.map((t) => { const k = `:w${n++}`; params[k] = t; return k; }).join(',');
      return `p.id ${neg ? 'NOT ' : ''}IN (SELECT post_id FROM post_tags WHERE tag IN (${ph}))`;
    });
    return db.all(
      `SELECT p.* FROM posts p WHERE ${conds.join(' AND ')} AND ${PLAYABLE} ${DEAD}
       ${ORDER} LIMIT :l OFFSET :o`,
      { ...params, ':l': limit, ':o': offset },
    );
  }
  return db.all(
    `SELECT p.* FROM posts p WHERE ${PLAYABLE} ${DEAD}
     ${ORDER} LIMIT :l OFFSET :o`,
    { ':l': limit, ':o': offset },
  );
}

// Какие из слов уже в индексе (есть посты) — их автодополнение не правит:
// indexed-lookup, ≤1 строка на слово. Минус-слова ищем без знака.
export async function knownTags(words) {
  const rows = await Promise.all(words.map((t) =>
    db.get('SELECT tag FROM post_tags WHERE tag = :t LIMIT 1', { ':t': t.replace(/^-/, '') })));
  return new Set(rows.filter(Boolean).map((r) => r.tag));
}

// «long hair» → long_hair, «2 girls» → [2_girls, 2girls]: соседние слова пробуем
// склеить (через _ и встык — числовые теги данбоору пишутся без _), если такой тег
// есть в индексе. Склейка заменяет пару слов — это главная опечатка новичка; есть
// оба написания — один слот-альтернатива (ИЛИ), а не два И-условия. Слоты = массивы.
// Минус-слово клеится только с минус-словом, знак сохраняется в слоте.
// (экспортируется и для хендлера инлайна: склейка ДО правки опечаток, см. inline_query.js)
export async function glueWords(words) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const neg = words[i].startsWith('-');
    const a = neg ? words[i].slice(1) : words[i];
    if (i + 1 < words.length && words[i + 1].startsWith('-') === neg) {
      const b = neg ? words[i + 1].slice(1) : words[i + 1];
      const cands = [`${a}_${b}`, `${a}${b}`];
      const has = await knownTags(cands);
      const hits = cands.filter((t) => has.has(t)).map((t) => (neg ? `-${t}` : t));
      if (hits.length) { out.push(hits); i++; continue; }
    }
    out.push([neg ? `-${a}` : a]);
  }
  return out;
}

// webm/zip в инлайне не проигрываются — их не выдаём.
export function resultTypeOfExt(ext) {
  const e = String(ext ?? '').toLowerCase().replace(/^\./, '');
  if (e === 'jpg' || e === 'jpeg' || e === 'png' || e === 'webp') return 'photo';
  if (e === 'gif') return 'gif';
  if (e === 'mp4') return 'mpeg4_gif'; // короткие mp4 — автоплеем, как у всех боору-ботов
  return null;
}

function postToResult(p) {
  const id = String(p.id);
  // Уже в кэше ТГ (канал-дамп) — лимиты URL-выдачи не действуют; anim крутится в списке.
  if (p.file_kind === 'anim' && p.file_id) {
    return { type: 'mpeg4_gif', id, mpeg4_file_id: p.file_id };
  }
  if (p.file_kind === 'video' && p.file_id) {
    return { type: 'video', id, video_file_id: p.file_id, title: titleOf(p) };
  }
  const type = resultTypeOfExt(p.file_ext);
  const thumb = p.thumb_url || p.file_url;
  if (type === 'photo') {
    const dims = p.width && p.height ? { photo_width: p.width, photo_height: p.height } : {};
    return { type, id, photo_url: p.file_url, thumb_url: thumb, ...dims };
  }
  if (!p.thumb_url) return null; // превью у gif/mp4 обязательно, иначе ТГ отклонит результат
  if (type === 'gif') {
    return { type, id, gif_url: p.file_url, thumb_url: p.thumb_url };
  }
  if (type === 'mpeg4_gif') {
    // Автогифка только для заведомо лёгких (≤1 МБ); тяжёлые и с неизвестным
    // размером — карточка video (до 20 МБ работает, SQL отсёк известные >20 МБ)
    if (p.file_size == null || p.file_size > 1000000) {
      const dims = p.width && p.height ? { video_width: p.width, video_height: p.height } : {};
      return {
        type: 'video', id, video_url: p.file_url, mime_type: 'video/mp4',
        thumb_url: p.thumb_url, title: titleOf(p), ...dims,
      };
    }
    return { type, id, mpeg4_url: p.file_url, thumb_url: p.thumb_url };
  }
  return null;
}

// Заголовок video-карточки: у постов нет тайтлов — размеры и источник.
function titleOf(p) {
  return (p.width && p.height ? `${p.width}×${p.height} · ` : '') + p.site;
}

// Упаковка строк posts в инлайн-результаты с кнопкой «Поиск» (как в buildResults).
export function rowsToResults(rows, buttonText) {
  const label = buttonText ?? '';
  const keyboard = {
    reply_markup: {
      inline_keyboard: [[{ text: 'Поиск', switch_inline_query_current_chat: label }]],
    },
  };
  return rows.slice(0, PAGE).map(postToResult).filter(Boolean).map((r) => ({ ...r, ...keyboard }));
}

// next_offset со слотами («20:a|b c»), если влезает в лимит 64 байта (UTF-8);
// не влезает — голый offset, слоты на стр. 2 просто не повторятся.
export function carryOffset(nextOffset, slots) {
  const carry = `${nextOffset}:${slots.map((s) => s.join('|')).join(' ')}`;
  let bytes = 0; // UTF-8: кириллица в запросе ест по 2 байта на букву
  for (const ch of carry) { const c = ch.codePointAt(0); bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
  return bytes <= 64 ? carry : String(nextOffset);
}

// Трёхслойная выдача (первая страница приоритетного поиска):
//   ядро       — И по всем переведённым тегам (точное соответствие запросу);
//   частичный  — популярные посты с главным тегом среди прочих — когда И-ядро
//                не покрыло страницу и ядро состоит из 2+ тегов (при одном теге
//                ядро и есть «среди прочих»);
//   семантика  — ИЛИ по соседним тегам эмбед-модели + главный тег: популярное
//                по теме подмешивается к семантике, а не заменяет её (выдача
//                ИЛИ-поиска уже отсортирована по hits).
// Слои не дублируются (по id поста), лимит rows_read — ≤3 запроса по LIMIT PAGE+1.
// maxOr — максимум тегов в ИЛИ-слоте (RU_MAX_OR хендлера).
export async function layeredResults(coreTags, semTags, maxOr) {
  const core = coreTags ?? [];
  const picked = [];
  const seen = new Set();
  const take = (rows) => {
    for (const r of rows || []) {
      if (picked.length >= PAGE) return;
      if (!seen.has(r.id)) { seen.add(r.id); picked.push(r); }
    }
  };
  if (core.length) {
    take(await searchPosts(core.map((t) => [t]), PAGE + 1, 0)); // ядро: И
    if (picked.length < PAGE && core.length > 1) {
      take(await searchPosts([[core[0]]], PAGE + 1, 0)); // частичный слой
    }
  }
  if (picked.length < PAGE) {
    const orSet = [...new Set([core[0], ...(semTags ?? [])].filter(Boolean))].slice(0, maxOr);
    if (orSet.length) take(await searchPosts([orSet], PAGE + 1, 0)); // семантика + популярное по теме
  }
  return picked;
}

// Что ответить на инлайн-запрос: { results, next_offset?, searched? }
// slots — ИЛИ-слоты после склейки (массив массивов, элементы могут нести '-');
// текст сюда НЕ пере-парсим, иначе альтернативы слота («2_girls|2girls»)
// превратились бы из одного ИЛИ в два И-слова. searched — плоский список тегов:
// хендлер сеет в очередь ровно то, что искал, иначе обещание заглушки
// «добавляю в базу» может не сбыться. buttonText — текст кнопки «Поиск»
// и заглушки (исправленный запрос); нет — собираем из слотов.
export async function buildResults(slots, offsetStr, buttonText) {
  const searched = [...new Set(slots.flat())];
  const offset = Math.max(0, parseInt(offsetStr || '0', 10) || 0);
  const rows = await searchPosts(slots, PAGE + 1, offset);
  const more = rows.length > PAGE;
  const label = buttonText ?? searched.join(' ');
  // Кнопка «Поиск» под отправленным постом: снова открывает инлайн-поле
  // с тем же запросом — можно поправить теги и поискать заново.
  const results = rowsToResults(rows, label);
  // Пусто на первой странице: вместо тишины одна заглушка-статья — клик отправит
  // её текст в чат; спрос тем временем сеется в очередь (handlers/inline_query.js).
  // Только первая страница: пустой хвост пагинации — не «тега нет в базе».
  if (offset === 0 && !results.length && searched.length) {
    const title = `Добавляю «${label}» в базу`;
    return {
      searched,
      results: [{
        type: 'article', id: 'stub', title,
        description: 'Такого тега пока нет — нажми и приходи позже',
        input_message_content: { message_text: `${title}, приходи позже` },
        reply_markup: {
          inline_keyboard: [[{ text: 'Поиск', switch_inline_query_current_chat: label }]],
        },
      }],
    };
  }
  if (!more) return { searched, results };
  // Слоты едут в next_offset («20:2_girls|2girls senko», '|' — альтернативы одного
  // ИЛИ-слота): ТГ присылает стр. 2 с ИСХОДНЫМ текстом, без этого и слоты-альтернативы,
  // и исправление опечатки на стр. 2 теряются.
  return { searched, results, next_offset: carryOffset(offset + PAGE, slots) };
}

// Текстовый путь (dev-эндпоинт и тесты): распарсить и склеить текст, дальше — buildResults.
export async function buildFromQuery(queryText, offsetStr) {
  const slots = await glueWords(parseTags(queryText));
  return buildResults(slots, offsetStr, queryText);
}

// +1 к популярности поста (когда пользователь выбрал результат).
export async function bumpPost(postId) {
  await db.run('UPDATE posts SET hits = hits + 1 WHERE id = :id', { ':id': postId });
}

// Для крауллера: добавить/обновить пост, привязать теги.
// Глобальный дедуп: пост с хэшем, уже лежащим от другого сайта, не вставляем —
// возвращаем { id, dup: true }. Иначе { id, dup: false }.
export async function upsertPost({ site, remoteId, fileUrl, thumbUrl, fileExt, width, height, size, tags, hash }) {
  const clean = parseTags((tags ?? []).join(' '));
  const h = hash ? String(hash).toLowerCase() : null;
  if (h) {
    const twin = await db.get(
      'SELECT id, site FROM posts WHERE md5 = :h AND (site != :site OR remote_id != :rid) LIMIT 1',
      { ':h': h, ':site': site, ':rid': String(remoteId) },
    );
    if (twin) return { id: twin.id, dup: true };
  }
  // Один upsert вместо update→insert→select; RETURNING отдаёт id в обеих ветках
  // (raw-запрос — docs «Raw SQL»: db.run(... RETURNING id) возвращает rows).
  // COALESCE: известный размер/хэш не затираем NULL'ом.
  const { rows } = await db.run(
    `INSERT INTO posts(site, remote_id, file_url, thumb_url, file_ext, width, height, file_size, md5)
     VALUES (:site, :rid, :fu, :tu, :ext, :w, :h, :fs, :mh)
     ON CONFLICT(site, remote_id) DO UPDATE SET
       file_url = excluded.file_url, thumb_url = excluded.thumb_url, file_ext = excluded.file_ext,
       width = excluded.width, height = excluded.height,
       file_size = COALESCE(excluded.file_size, posts.file_size), md5 = COALESCE(excluded.md5, posts.md5)
     RETURNING id`,
    {
      ':site': site, ':rid': String(remoteId), ':fu': fileUrl,
      ':tu': thumbUrl ?? null, ':ext': fileExt, ':w': width ?? null, ':h': height ?? null,
      ':fs': size ?? null, ':mh': h,
    },
  );
  const id = rows[0]?.id;
  if (id == null || !clean.length) return { id, dup: false };
  const placeholders = clean.map((t, i) => `(:id, :tag${i})`).join(',');
  await db.run(
    `INSERT INTO post_tags(post_id, tag) VALUES ${placeholders} ON CONFLICT DO NOTHING`,
    { ':id': id, ...Object.fromEntries(clean.map((t, i) => [`:tag${i}`, t])) },
  );
  return { id, dup: false };
}

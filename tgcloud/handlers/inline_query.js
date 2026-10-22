// handlers/inline_query.js — инлайн-режим: пользователь вводит теги, бот
// отвечает постами из БД, популярное первым. Инлайн включается у @BotFather
// (/setinline), без этого update'ы не приходят.

import { api, BotApiError, db } from 'sdk';
import { buildResults, parseTags, knownTags, glueWords, layeredResults, rowsToResults, carryOffset, PAGE } from '../lib/booru.js';
import { correctTags } from '../lib/suggest.js';
import { maybeTick, seedDemandTags } from '../lib/queue.js';
import { ruToTags } from '../lib/ru.js';
import tick from '../endpoints/tick.js';
import fileTick from '../endpoints/filetick.js';

// ─── Русский инлайн ──────────────────────────────────────────────────────────
// Телеграм присылает inline_query на КАЖДОЕ нажатие клавиши. Переводить каждый
// промежуточный префикс в модель нельзя — поэтому два ограждения:
//   • короче 3 символов — это середина набора, не переводим вовсе;
//   • тот же пользователь писал меньше 500 мс назад — считаем, что он ещё
//     печатает, и модель НЕ зовём (работают только кэш и лексический словарь).
// Когда пользователь останавливается, приходит следующий update — он уже
// проходит полный путь с эмбеддингом.
const RU_MIN_LEN = 3;     // порог длины запроса для перевода
const RU_SETTLE_MS = 500; // столько покоя ждём перед отправкой данных в модель
const CYRILLIC = /[а-яё]/i;
// Сколько переведённых тегов ещё можно склеивать через И, и сколько брать в
// ИЛИ-слот, когда перевод вышел размытым. Замерено: «long_hair 1girl» (И) даёт
// полную страницу, «cat kote coat couch» (И) — ноль постов, только заглушку.
// Поэтому короткий точный перевод идёт как И (сужает), длинный — как ИЛИ.
const RU_MAX_AND = 3;
const RU_MAX_OR = 8;

// Русский ли текст (кириллица). Английские теги перевод не трогает.
function isRussianText(t) { return CYRILLIC.test(t ?? ''); }

// true — с прошлого запроса этого пользователя прошло ≥ RU_SETTLE_MS.
// Заодно записывает текущий запрос как последний (таблица inline_seen).
// Любая ошибка БД трактуется как «пользователь остановился» — лучше позвать
// модель, чем молча не ответить.
async function hasSettled(userId, text) {
  const now = Date.now();
  if (!userId) return true;
  let prev = null;
  try {
    prev = await db.get('SELECT at FROM inline_seen WHERE user_id = :u', { ':u': userId });
  } catch (e) { console.log('inline_seen read failed:', e.message ?? e); }
  try {
    await db.run(
      'INSERT OR REPLACE INTO inline_seen (user_id, q, at) VALUES (:u, :q, :a)',
      { ':u': userId, ':q': String(text).slice(0, 200), ':a': now },
    );
  } catch (e) { console.log('inline_seen write failed:', e.message ?? e); }
  return !prev || now - Number(prev.at) >= RU_SETTLE_MS;
}

export default async function (q) {
  let queryText = q.query ?? '';
  let rawRu = null;      // исходный русский текст — кнопке «Поиск», вместо тегов
  let ruAndSlots = false; // перевод собран И-слотами — есть куда откатиться в ИЛИ
  let seed = null;
  let slots = null;      // ИЛИ-слоты запроса после склейки (см. glueWords)
  let buttonText = null; // исправленный запрос — кнопке «Поиск» и заглушке
  let ruCore = null;     // ядро перевода (точное соответствие) — слоёная выдача
  let ruSem = null;      // семантические соседи перевода (хвост выдачи)
  // Пагинация: ТГ шлёт стр. 2+ с ИСХОДНЫМ текстом — слоты (склейка, ИЛИ-альтернативы
  // и правка опечаток) едут в next_offset «<offset>:<слоты через пробел, альтернативы
  // одного слота через |>» и на стр. 2 собираются 1:1, править там нечего.
  const page = /^(\d+):([\s\S]*)$/.exec(q.offset ?? '');
  if (page) {
    queryText = page[2];
    slots = queryText.split(/\s+/).filter(Boolean).map((t) => t.split('|'));
    buttonText = queryText;
  }
  // Русский запрос → английские теги (см. ограждения выше). Подставляем перевод в
  // queryText, и дальше он идёт обычным путём — как будто пользователь ввёл теги
  // сам (склейка, правка опечаток, поиск по индексу работают как обычно).
  // Страницы 2+ не переводим: там слоты уже лежат в offset.
  if (!page && isRussianText(queryText) && queryText.trim().length >= RU_MIN_LEN) {
    const settled = await hasSettled(q.from && q.from.id, queryText);
    const { tags, src, core, semantic } = await ruToTags(queryText, { allowModel: settled });
    if (tags.length) {
      rawRu = queryText;
      queryText = tags.join(' ');
      // Короткий перевод — разные понятия («long_hair 1girl», «1girl red_hair»):
      // каждое своим И-слотом, выдача сужается, как у обычного английского
      // запроса. Длинный — семантика добрала соседей по вектору («кот» →
      // cat + coat/couch/ascot…): в И такое даёт гарантированный ноль, поэтому
      // кладём одним ИЛИ-слотом — найдётся хоть что-то, отсортированное по
      // популярности. Пороги RU_MAX_AND/RU_MAX_OR замерены на живой БД.
      slots = tags.length <= RU_MAX_AND
        ? tags.map((t) => [t])
        : [tags.slice(0, RU_MAX_OR)];
      // И-схема из 2+ тегов может дать пусто — держим флаг, чтобы ниже был
      // откат в ИЛИ (см. проверку заглушки после buildResults).
      ruAndSlots = tags.length > 1 && tags.length <= RU_MAX_AND;
      // Слои приоритетной выдачи (первая страница): ядро — точный перевод,
      // частичный слой и семантика дозаполняют (см. booru.layeredResults).
      ruCore = core; ruSem = semantic;
    }
    console.log(`ru: «${rawRu ?? queryText}» → [${tags.join(' ')}] src=${src} settled=${settled}` +
      ` slots=${slots ? JSON.stringify(slots) : '—'}`);
  }
  // Автодополнение ДО поиска, но только на первой странице (скролл пустого
  // хвоста не должен снова поднимать запросы к сайтам) и только для слов,
  // которых нет в индексе: тёплые запросы ничего не платят, опечатка (senke →
  // senko) ищется один раз, а не дважды.
  // !slots — русский перевод уже собрал слоты выше, автодополнение по сайтам
  // ему не нужно (это были бы лишние запросы к боору ради уже готовых тегов).
  else if (!slots && !(q.offset && q.offset !== '0') && queryText.trim()) {
    let glued = null;
    let fixed = null;
    try {
      // Сначала склейка («long hair» → long_hair), правим только остаток: по
      // отдельности слова пары — не теги, correctTags увёл бы их на автодополнения
      // сайтов и сломал И-запрос. Склеенное — теги индекса, correctTags их пропустит.
      glued = await glueWords(parseTags(queryText));
      const flat = glued.flat();
      fixed = await correctTags(flat, await knownTags(flat));
    } catch (e) { console.log('correctTags skipped:', e.message ?? e); }
    if (fixed) {
      // correctTags.search выровнен 1:1 с flat — режем его обратно на слоты по
      // длинам склейки (члены слота — известные теги, правка там identity).
      slots = []; let k = 0;
      for (const s of glued) { slots.push(fixed.search.slice(k, k + s.length)); k += s.length; }
      buttonText = fixed.search.join(' ');
      seed = fixed.seed;
    } else slots = glued; // правка упала — ищем склеенный, но неисправленный запрос
  }
  if (!slots) {
    // Legacy-цифра в offset (без «:») или пустой запрос: склейка сырого текста
    // без правки — на стр. 2+ она не повторяется (как и раньше).
    try { slots = await glueWords(parseTags(queryText)); }
    catch { slots = parseTags(queryText).map((t) => [t]); }
    buttonText = queryText;
  }
  // Кнопка «Поиск» показывает исходный русский запрос, а не подставленные теги:
  // нажатие вернёт пользователя в инлайн с его же текстом.
  if (rawRu) buttonText = rawRu;
  // Приоритетная (слоёная) первая страница русского запроса: ядро → частичный
  // слой → семантика (booru.layeredResults). Страницы 2+ и не-русские запросы —
  // обычный путь через buildResults; если слои не дали ни одного поста — тоже
  // обычный путь (он поставит заглушку «добавляю в базу»).
  let layered = null;
  if (!page && ruCore && (ruCore.length || (ruSem && ruSem.length))) {
    const rows = await layeredResults(ruCore, ruSem, RU_MAX_OR);
    const results = rowsToResults(rows, rawRu);
    if (results.length) {
      layered = {
        results,
        // пагинация продолжает И/ИЛИ по слотам перевода — тот же контракт, что у buildResults
        next_offset: carryOffset(PAGE, slots),
        searched: [...new Set([...ruCore, ...ruSem])],
      };
      console.log(`ru: слои ядро=[${ruCore}] семантика=[${ruSem}] → ${rows.length} постов`);
    }
  }
  let { results, next_offset, searched } = layered ?? await buildResults(slots, page ? page[1] : q.offset, buttonText);
  // Откат для русского И-запроса: «autumn fog forest» вместе в базе не
  // встречаются — каждое слово есть, а пересечения нет, и пользователь получил
  // бы заглушку «добавляю в базу» на теги, которые уже лежат. Замерено на полном
  // индексе. Повторяем одним ИЛИ-слотом: широкая выдача лучше пустоты, а сама
  // заглушка остаётся только для случая, когда пусто и по ИЛИ.
  if (ruAndSlots && results.length === 1 && results[0].id === 'stub') {
    const alt = await buildResults([slots.flat().slice(0, RU_MAX_OR)], page ? page[1] : q.offset, buttonText);
    const altStub = alt.results.length === 1 && alt.results[0].id === 'stub';
    console.log(`ru: И-запрос пуст, откат в ИЛИ → ${altStub ? 'тоже пусто' : 'ок, ' + alt.results.length + ' результатов'}`);
    if (!altStub) { results = alt.results; next_offset = alt.next_offset; searched = alt.searched; }
  }
  const stubOnly = results.length === 1 && results[0].id === 'stub'; // заглушка пустого поиска
  if (results.length && !stubOnly) seed = null; // нашли — сеять нечего
  try {
    await api.answerInlineQuery({
      inline_query_id: q.id,
      results,
      cache_time: 30, // повторные запросы ТГ отдаёт из своего кэша мгновенно
      ...(next_offset !== undefined ? { next_offset } : {}),
    });
  } catch (e) {
    if (!(e instanceof BotApiError && e.code === 400)) throw e; // 400 = запрос истёк, это норма
    console.log('answerInlineQuery 400:', e.description); // но кривые результаты тоже 400 — оставляем след
  }
  // Сеем после ответа: запись в БД не должна задерживать ответ пользователю,
  // но до тиков — чтобы идущий следом тик сразу взялся за свежие теги.
  // searched — склеенные теги запроса (correctTags их не знает); при заглушке
  // сеем всегда — она обещала «добавляю в базу», даже если correctTags упал.
  // Русский текст в очередь краула не сеем: теги на боору английские, сырой
  // кириллический запрос там мусор. Перевод прошёл — там уже английские теги,
  // их сеять можно (условие смотрит на итоговый queryText, не на исходный).
  if ((seed || stubOnly) && !isRussianText(queryText)) {
    await seedDemandTags([...(seed ?? []), ...(searched ?? [])]);
  }
  // Фоновое пополнение после ответа: краул-тик (раз в 5 мин) и видеокачвейер (раз
  // в 30 с). Краул первым — тяжёлое видео не убьёт уже сохранённую работу краула.
  await maybeTick(tick);
  await maybeTick(fileTick);
}

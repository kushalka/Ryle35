// handlers/inline_query.js — инлайн-режим: пользователь вводит теги, бот
// отвечает постами из БД, популярное первым. Инлайн включается у @BotFather
// (/setinline), без этого update'ы не приходят.

import { api, BotApiError } from 'sdk';
import { buildResults, parseTags, knownTags } from '../lib/booru.js';
import { correctTags } from '../lib/suggest.js';
import { maybeTick, seedDemandTags } from '../lib/queue.js';
import tick from '../endpoints/tick.js';
import fileTick from '../endpoints/filetick.js';

export default async function (q) {
  let queryText = q.query ?? '';
  let seed = null;
  // Автодополнение ДО поиска, но только на первой странице (скролл пустого
  // хвоста не должен снова поднимать запросы к сайтам) и только для слов,
  // которых нет в индексе: тёплые запросы ничего не платят, опечатка (senke →
  // senko) ищется один раз, а не дважды.
  if (!(q.offset && q.offset !== '0') && queryText.trim()) {
    let fixed = null;
    try {
      const words = parseTags(queryText);
      fixed = await correctTags(words, await knownTags(words));
    } catch (e) { console.log('correctTags skipped:', e.message ?? e); }
    if (fixed) {
      queryText = fixed.search.join(' ') || queryText;
      seed = fixed.seed;
    }
  }
  const { results, next_offset, searched } = await buildResults(queryText, q.offset);
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
  if (seed || stubOnly) await seedDemandTags([...(seed ?? []), ...(searched ?? [])]);
  // Фоновое пополнение после ответа: краул-тик (раз в 5 мин) и видеокачвейер (раз в
  // минуту). Краул первым — тяжёлое видео не убьёт уже сохранённую работу краула.
  await maybeTick(tick);
  await maybeTick(fileTick);
}

// endpoints/zz_seed_vec.js — индексация тегов в tag_vec: эмбеддинги OpenRouter
// (lib/embed.js) → int8[512] → base64 → INSERT в облачную таблицу tag_vec.
//
// Постоянный модуль сборки/дельты индекса. Драйвер — _index_build/build_index.py:
//   --vocab-only / --refresh-vocab читают mode:'vocab' (частоты из post_tags),
//   обычный прогон докладывает только теги, которых ещё нет в tag_vec.
//
// Вызов:
//   npx tgcloud run endpoints/zz_seed_vec '{"rows":[["cat",10],["dog",5]]}'
//   → { inserted, failed, rows: [[tag, n, v], ...], failedRows: [[tag, why], ...] }
//     rows — только успешно заэмбедденные строки: драйвер (_index_build/build_index.py)
//     сохраняет их в локальный бэкап _index/tag_vec.jsonl, поэтому вектор должен
//     вернуться назад по сети вместе с ответом.
//
// Возобновление: сколько тегов уже лежит в tag_vec (страницами, дешёвое чтение):
//   '{"mode":"existing","after":"","limit":2000}'
//   → { tags: ["aa", ...], next: "aa", count: N }   (next — курсор, '' когда конец)
//
// Изолят: нет process.env, нет Buffer/btoa, нет setTimeout — только то, что
// даёт sdk. Эмбеддинги батчатся, вставки чанкуются (rows * columns ≤ ~900).
import { db } from 'sdk';
import { indexText, embedTexts, quantize, bytesToB64, EMBED_DIM } from '../lib/embed.js';

// 128 — жёсткий лимит провайдера, а не наша экономия: на 129+ он отвечает
// 400 "Too big: expected array to have <=128 items" (замерено зондом zz_tmp_emb).
// 200 тут стоило лишнего заведомо падающего запроса на каждый батч.
const EMB_BATCH = 128;
const EMB_MIN = 20;      // ниже не дробим: батч такого размера падает уже по-настоящему
const INS_ROWS = 250;    // 250 * 3 колонки = 750 переменных ≤ ~900 на statement
const TAG_PAGE = 2000;   // строк tag_vec за одно чтение в режиме existing
const TAG_PAGE_MAX = 10000;

// base64 от int8[EMBED_DIM]: ceil(512/3)*4 = 684 символа — инвариант для проверки
// целостности ответа на стороне драйвера.
const B64_LEN = Math.ceil(EMBED_DIM / 3) * 4;

function msg(e) {
  const s = e && e.message ? e.message : String(e);
  return s.replace(/\s+/g, ' ').slice(0, 160);
}

// Нормализация входа: строки вида [tag, n]. Мусор отбрасываем в failedRows,
// дубли внутри одного вызова схлопываем по максимуму n (иначе один statement
// дважды вставит один и тот же PRIMARY KEY).
function normalize(input) {
  const rows = Array.isArray(input && input.rows) ? input.rows : [];
  const byTag = new Map();
  const bad = [];
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 2) { bad.push([String(r && r[0]), 'bad row']); continue; }
    const tag = String(r[0] == null ? '' : r[0]).trim();
    if (!tag) { bad.push(['', 'empty tag']); continue; }
    const n = Number(r[1]);
    const nn = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    const prev = byTag.get(tag);
    if (prev === undefined || nn > prev) byTag.set(tag, nn);
  }
  return { list: [...byTag.entries()].map(([tag, n]) => [tag, n]), bad };
}

export default async function (input, ctx) {
  const t0 = Date.now();
  const inp = input || {};

  // Это модуль СБОРКИ индекса, а не публичный API. Эндпоинты вызываются
  // мини-аппом как POST /api/<name> любым пользователем с валидным initData —
  // писать в БД оттуда нельзя. Локальный `tgcloud run` ctx не передаёт, мини-апп
  // передаёт всегда, поэтому такой вызов отсекается.
  if (ctx && ctx.initData) return { error: 'build-time tool, not callable from the Mini App' };

  // ── режим чтения: частоты тегов из post_tags (для дельта-пересборки) ──
  // Страницами по tag: WHERE tag > :a режет по idx_post_tags_tag, GROUP BY
  // считает только страницы, вся таблица за один вызов не читается.
  if (inp.mode === 'vocab') {
    const after = String(inp.after == null ? '' : inp.after);
    const limit = Math.min(Math.max(Math.floor(Number(inp.limit)) || 2000, 1), TAG_PAGE_MAX);
    const rows = await db.all(
      `SELECT tag, count(*) AS n FROM post_tags WHERE tag > :a GROUP BY tag ORDER BY tag LIMIT ${limit}`,
      { ':a': after },
    );
    return {
      rows: rows.map((r) => [r.tag, r.n]),
      next: rows.length === limit ? rows[rows.length - 1].tag : '',
      ms: Date.now() - t0,
    };
  }

  // ── режим чтения: страница уже проиндексированных тегов (для возобновления) ──
  if (inp.mode === 'existing') {
    const after = String(inp.after == null ? '' : inp.after);
    const limit = Math.min(Math.max(Math.floor(Number(inp.limit)) || TAG_PAGE, 1), TAG_PAGE_MAX);
    // tag — PRIMARY KEY, поэтому tag > :a ORDER BY tag LIMIT n идёт по индексу.
    // LIMIT подставляем числом: значение уже провалидировано целым, а именованный
    // параметр в LIMIT планировщик не всегда принимает.
    const rows = await db.all(
      `SELECT tag FROM tag_vec WHERE tag > :a ORDER BY tag LIMIT ${limit}`,
      { ':a': after },
    );
    let count = null;
    try {
      const c = await db.get('SELECT count(*) AS n FROM tag_vec');
      count = c && c.n;
    } catch (e) {
      count = null; // count(*) читает всю таблицу и может вылезти за rows_read
    }
    return {
      tags: rows.map((r) => r.tag),
      next: rows.length === limit ? rows[rows.length - 1].tag : '',
      count,
      ms: Date.now() - t0,
    };
  }

  const { list, bad } = normalize(inp);
  const emb = [];        // [tag, n, v] — заэмбеддено, пойдёт в локальный бэкап
  const failedRows = [...bad];  // [tag, why] — эмбеддинг/квантизация не удались
  const dbFailed = [];   // [tag, why] — вектор есть, но INSERT не прошёл
  const ins = { n: 0 };

  if (!list.length) {
    return { inserted: 0, failed: failedRows.length, rows: [], failedRows, dbFailed, embCalls: 0, ms: Date.now() - t0 };
  }

  // ── 1) эмбеддинги: дробим батч пополам при ошибке, но не больше бюджета ──
  // Бюджет — предохранитель от шторма 429: если провайдер лежит, дробление
  // 200→100→50→20 множит число запросов, поэтому после исчерпания бюджета
  // остаток просто помечается failed (драйвер повторит эти теги позже).
  const budget = 6 * Math.ceil(list.length / EMB_BATCH) + 6;
  const calls = { n: 0 };

  async function embedSlice(slice) {
    if (calls.n >= budget) {
      for (const r of slice) failedRows.push([r[0], 'skipped: embed call budget']);
      return;
    }
    calls.n++;
    let vecs = null;
    let err = null;
    try {
      vecs = await embedTexts(slice.map((r) => indexText(r[0])));
      if (!vecs || vecs.length !== slice.length) {
        throw new Error(`count mismatch: got ${vecs ? vecs.length : 0} of ${slice.length}`);
      }
    } catch (e) {
      err = e;
    }
    if (err) {
      if (slice.length > EMB_MIN) {
        const mid = Math.ceil(slice.length / 2);
        await embedSlice(slice.slice(0, mid));
        await embedSlice(slice.slice(mid));
        return;
      }
      const why = 'embed: ' + msg(err);
      for (const r of slice) failedRows.push([r[0], why]);
      return;
    }
    for (let k = 0; k < slice.length; k++) {
      const tag = slice[k][0];
      try {
        const v = bytesToB64(quantize(vecs[k]));
        if (v.length !== B64_LEN) throw new Error(`v len ${v.length} != ${B64_LEN}`);
        emb.push([tag, slice[k][1], v]);
      } catch (e) {
        failedRows.push([tag, 'quant: ' + msg(e)]);
      }
    }
  }

  for (let i = 0; i < list.length; i += EMB_BATCH) {
    await embedSlice(list.slice(i, i + EMB_BATCH));
  }

  // ── 2) вставка чанками: rows * 3 ≤ ~900 переменных ──
  // ВНИМАНИЕ: изолят принимает только ИМЕНОВАННЫЕ параметры (:t, :n, :v) —
  // позиционные (?) падают с "Run error" (проверено зондом zz_tmp_ins).
  // При ошибке чанка падаем на построчные вставки, чтобы одна битая строка не
  // утащила 250 соседних.
  for (let i = 0; i < emb.length; i += INS_ROWS) {
    const part = emb.slice(i, i + INS_ROWS);
    const ph = part.map((_, k) => `(:t${k}, :n${k}, :v${k})`).join(', ');
    const args = {};
    part.forEach((r, k) => {
      args[`:t${k}`] = r[0];
      args[`:n${k}`] = r[1];
      args[`:v${k}`] = r[2];
    });
    try {
      await db.run(`INSERT OR REPLACE INTO tag_vec (tag, n, v) VALUES ${ph}`, args);
      ins.n += part.length;
    } catch (e) {
      for (const r of part) {
        try {
          await db.run(
            'INSERT OR REPLACE INTO tag_vec (tag, n, v) VALUES (:t, :n, :v)',
            { ':t': r[0], ':n': r[1], ':v': r[2] },
          );
          ins.n += 1;
        } catch (e2) {
          dbFailed.push([r[0], 'db: ' + msg(e2)]);
        }
      }
    }
  }

  return {
    inserted: ins.n,
    failed: failedRows.length + dbFailed.length,
    rows: emb,
    failedRows,
    dbFailed,
    embCalls: calls.n,
    embBatch: EMB_BATCH,
    insRows: INS_ROWS,
    ms: Date.now() - t0,
  };
}

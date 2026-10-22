// tgcloud/lib/embed.js — клиент эмбеддингов OpenRouter + кодеки векторов.
//
// ВАЖНО: индекс тегов (таблица tag_vec) собран ТОЙ ЖЕ моделью, что указана в
// EMBED_MODEL, и в том же формате текста, что INDEX_TEXT_FORMAT. Смена модели
// или формата = полный пересбор индекса (_index_build/build_index.py).
//
// В изоляте нет process.env — ключ берётся из tgcloud/lib/aikeys.js (gitignored).
import { fetch } from 'sdk';
import { openrouter } from './aikeys.js';

export const EMBED_MODEL = 'liquid/lfm-2.5-embedding-350m:free';
export const EMBED_URL = 'https://openrouter.ai/api/v1/embeddings';
export const FULL_DIM = 1024;   // сколько отдаёт модель
export const EMBED_DIM = 512;   // сколько храним (транкейт первых EMBED_DIM, замерено: качество не падает)
export const Q_PREFIX = '';     // префикс к тексту запроса при эмбеддинге

// Текст, которым индексируется тег. Держать синхронно с build_index.py.
export function indexText(tag) {
  return `${tag} (${String(tag).replace(/_/g, ' ')})`;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64INV = (() => {
  const m = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) m[B64.charCodeAt(i)] = i;
  return m;
})();

export function bytesToB64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[b2 & 63] : '=';
  }
  return out;
}

export function b64ToBytes(s) {
  const clean = String(s).replace(/[^A-Za-z0-9+/]/g, '');
  const n = Math.floor(clean.length * 3 / 4);
  const out = new Uint8Array(n);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64INV[clean.charCodeAt(i)];
    const c1 = B64INV[clean.charCodeAt(i + 1)];
    const c2 = B64INV[clean.charCodeAt(i + 2)];
    const c3 = B64INV[clean.charCodeAt(i + 3)];
    if (o < n) out[o++] = (c0 << 2) | (c1 >> 4);
    if (o < n && c2 >= 0) out[o++] = ((c1 & 15) << 4) | (c2 >> 2);
    if (o < n && c3 >= 0) out[o++] = ((c2 & 3) << 6) | c3;
  }
  return out;
}

// Единичная нормализация → int8 [-127,127] как Uint8Array (знаковый байт + 128 не нужен:
// храним base64 от знаковых значений, приведённых к 0..255).
export function quantize(vec) {
  let n = 0;
  for (let i = 0; i < vec.length; i++) n += vec[i] * vec[i];
  n = Math.sqrt(n) || 1;
  const d = Math.min(vec.length, EMBED_DIM);
  const out = new Uint8Array(d);
  for (let i = 0; i < d; i++) {
    let q = Math.round((vec[i] / n) * 127);
    if (q > 127) q = 127;
    if (q < -127) q = -127;
    out[i] = q & 0xff;
  }
  return out;
}

// Косинус между квантованным запросом (Uint8Array) и base64-строкой документа.
// Оба вектора единичные, поэтому скалярное произведение / 127^2.
export function cosineInt8(qb, docB64) {
  const db = b64ToBytes(docB64);
  const n = Math.min(qb.length, db.length);
  let dot = 0;
  for (let i = 0; i < n; i++) {
    const a = qb[i] < 128 ? qb[i] : qb[i] - 256;
    const b = db[i] < 128 ? db[i] : db[i] - 256;
    dot += a * b;
  }
  return dot / (127 * 127);
}

export async function embedTexts(texts, model = EMBED_MODEL) {
  const res = await fetch(EMBED_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + openrouter.apiKey,
      'HTTP-Referer': 'https://t.me/Ryle35bot',
      'X-Title': 'Ryle35 inline search',
    },
    body: JSON.stringify({ model, input: texts }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`embeddings ${res.status}: ${body.slice(0, 200)}`);
  const data = JSON.parse(body);
  if (!data.data) throw new Error('embeddings: no data ' + body.slice(0, 200));
  return data.data.map((d) => d.embedding);
}

// Эмбеддинг запроса → квантованный вектор. null при любой ошибке (вызывающий
// код обязан иметь лексический фолбэк).
export async function embedQuery(text) {
  try {
    const [v] = await embedTexts([Q_PREFIX + text]);
    return quantize(v);
  } catch (e) {
    console.error('embedQuery failed', e && e.message);
    return null;
  }
}

// endpoints/tick.js — один шаг авто-пополнения БД. Крауллинг идёт ИЗ ОБЛАКА ТГ
// (sdk.fetch), будит его только пользовательский трафик: maybeTick в инлайн-хендлере.
// Лимиты: тик не чаще раза в 5 минут, за тик ≤4 сайтов (с истёкшим индивидуальным
// кулдауном, самые «старые» первыми) × 1 запрос.
// Проверка: npx tgcloud run endpoints/tick '{}'

import crawl, { SITES } from './crawl.js';
import { seedIfEmpty, nextTag, markCrawled, oldestSites, claimTick, expandFromPosts } from '../lib/queue.js';
import { db } from 'sdk';

const SITES_PER_TICK = 4;   // больше — не влезаем в ~20с вызова платформы
const TICK_INTERVAL = 300;  // сек между тиками вообще

// Гигиена ru_qcache: логический TTL записи 30 с (CACHE_TTL_MS в lib/ru.js), но
// сами строки без чистки копятся вечно. Мертвые записи (старше часа — с запасом
// к TTL) выметаем фоновым тиком, не на запросе: полная выборка на запросе —
// лишние rows_read. Кэш крошечный (~90 Б/строка), так что удалять раз в тик
// по индексу idx_ru_qcache_at дешевле, чем когда-либо считать квоту.
const QCACHE_STALE_MS = 60 * 60 * 1000;

async function sweepQcache() {
  try {
    const res = await db.run('DELETE FROM ru_qcache WHERE at < :cutoff', {
      ':cutoff': Date.now() - QCACHE_STALE_MS,
    });
    const n = res?.changes ?? res?.meta?.changes ?? 0;
    if (n > 0) console.log(`tick: swept ${n} stale ru_qcache rows`);
    return n;
  } catch (e) {
    console.error('tick: qcache sweep failed', e && e.message);
    return 0;
  }
}

export default async function tick() {
  if (!(await claimTick('_tick', TICK_INTERVAL))) return { done: 'too soon' };
  await sweepQcache();
  await seedIfEmpty();
  const cur = await nextTag();
  if (!cur) return { done: 'queue empty' };
  const due = (await oldestSites(Object.entries(SITES).map(([s, cfg]) => [s, cfg.cd ?? 900]))).slice(0, SITES_PER_TICK);
  if (!due.length) return { done: 'all sites recently crawled', tag: cur.tag };
  // кулдауны пишем ДО краулла: зависший сайт не должен съедать тик повторно, а при
  // крэше по ~20с лимиту платформы кулдауны уже записаны
  for (const site of due) await claimTick(site, 0); // интервал 0 = безусловный upsert кулдауна
  const res = await crawl({ tags: [cur.tag], limit: 100, sites: due, page: cur.page, collect: true });
  const got = res.sites.reduce((n, s) => n + (s.total || 0), 0);
  const answered = res.sites.some((s) => s.total !== undefined); // хоть один сайт ответил (ошибки не в счёт)
  const fresh = await expandFromPosts(res.posts ?? [], cur.priority);
  // понижать тег можно только по реальному пустому ответу, не по обраду всех сайтов
  await markCrawled(cur.tag, cur.priority, cur.page, answered ? got > 0 : true);
  console.log(`tick ${cur.tag} p${cur.page}: ${got} posts, +${fresh} tags in queue`);
  return { tag: cur.tag, page: cur.page, posts: got, newTags: fresh, sites: res.sites };
}

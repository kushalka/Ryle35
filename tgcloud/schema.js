import { table, integer, text, uniqueIndex, index, sql } from 'sdk/db';

// Посты с боору-сайтов — то, что выдаётся в инлайне.
export const posts = table('posts', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  site:      text('site').notNull(),      // хост источника, напр. 'danbooru.donmai.us'
  remoteId:  text('remote_id').notNull(), // id поста на сайте
  fileUrl:   text('file_url').notNull(),  // исходник (jpg/png/gif/mp4)
  thumbUrl:  text('thumb_url'),           // превью; если нет — инлайн возьмёт file_url
  fileExt:   text('file_ext').notNull(),  // jpg | png | webp | gif | mp4 | webm ...
  width:     integer('width'),
  height:    integer('height'),
  md5:       text('md5'),                 // хэш файла с сайта (md5/sha512) — глобальный дедуп
  fileSize:  integer('file_size'),        // байты; фильтр лимитов ТГ на инлайн-файлы (mp4 ≤1/20 МБ, gif ≤8 МБ)
  fileId:    text('file_id'),             // file_id в канале-дампе — кэш-выдача без лимитов URL
  fileKind:  text('file_kind'),           // anim | video | dead (dead = файл недоступен, не ретраим)
  hits:      integer('hits').notNull().default(0), // сколько раз выбрали в инлайне
  // никто не читает — только издержка на каждую вставку
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`)
    .deprecated('never read, insert overhead only'),
}, (t) => ({
  uq:      uniqueIndex('uidx_posts_site_remote').on(t.site, t.remoteId),
  hitsIdx: index('idx_posts_hits').on(t.hits),
  md5Idx:  index('idx_posts_md5').on(t.md5),
  // Порядок выдачи поиска (searchPosts): пустой запрос идёт по готовому порядку
  // индекса (обратный проход) и останавливается на LIMIT — без сортировки всей таблицы.
  rankIdx: index('idx_posts_rank').on(sql`(${t.fileId} is not null)`, t.hits, t.id),
}));

// Счётчик популярности тегов — write-only, на удаление (поиск сортирует по posts.hits).
export const tags = table('tags', {
  name: text('name').primaryKey(), // нормализованный тег, lowercase
  hits: integer('hits').notNull().default(0),
}).deprecated('write-only, ни одного читателя — поиск сортирует по posts.hits');

// Связь пост ↔ тег. FK нет — целостность держит код (lib/booru.js).
export const postTags = table('post_tags', {
  postId: integer('post_id').notNull(),
  tag:    text('tag').notNull(),
}, (t) => ({
  uq:   uniqueIndex('uidx_post_tags').on(t.postId, t.tag),
  tIdx: index('idx_post_tags_tag').on(t.tag, t.postId),
}));

// Очередь тегов для авто-пополнения: endpoints/tick берёт верхнюю, краулит, сдвигает.
export const crawlQueue = table('crawl_queue', {
  tag:      text('tag').primaryKey(),     // нормализованный тег
  priority: integer('priority').notNull().default(5), // сеяные = 10, найденные = родитель−1
  page:     integer('page').notNull().default(1), // следующая страница выдачи сайта
  lastAt:   integer('last_at', { mode: 'timestamp' }),
  addedAt:  integer('added_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
}, (t) => ({
  // nextTag сортирует выражением (priority − возраст) — индекс по голым колонкам
  // планировщик не использует, чистые накладные расходы на запись.
  nextIdx: index('idx_crawl_queue_next').on(t.priority, t.lastAt)
    .deprecated('nextTag orders by (priority - age) expression, unusable by planner'),
}));

// Персонализацию откатили (2026-10-10, владелец: «пусть всё общее») — таблицы на удаление.
export const userTags = table('user_tags', {
  userId: integer('user_id').notNull(),
  tag:    text('tag').notNull(),
  score:  integer('score').notNull().default(0),
  lastAt: integer('last_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
}).deprecated('personalization rolled back — global feed only');

export const userSeen = table('user_seen', {
  userId: integer('user_id').notNull(),
  postId: integer('post_id').notNull(),
  at:     integer('at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
}).deprecated('personalization rolled back — global feed only');

// Когда какой сайт последний раз краулили — соблюдение лимитов API.
export const crawlState = table('crawl_state', {
  site:   text('site').primaryKey(),      // хост из SITES или '_tick' (глобальный тик)
  lastAt: integer('last_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

// ─────────────────────────────────────────────────────────────────────────────
// Семантический индекс (RU-запросы → EN-теги). Отдельные таблицы, оригинальные
// данные не трогаются. Сборка: _index_build/build_index.py, модель — lib/embed.js.
// ─────────────────────────────────────────────────────────────────────────────

// Вектор тега: base64 int8[512], единичная норма. n — частота тега в post_tags,
// по ней читается top-K для сравнения (ORDER BY n DESC LIMIT K — по idx_tag_vec_n).
export const tagVec = table('tag_vec', {
  tag: text('tag').primaryKey(),
  n:   integer('n').notNull().default(0),
  v:   text('v').notNull(),
}, (t) => ({
  nIdx: index('idx_tag_vec_n').on(t.n),
}));

// Кэш перевода запроса в теги — чтобы один и тот же текст не эмбеддился повторно
// (TTL 30 с, как cache_time инлайна).
export const ruQcache = table('ru_qcache', {
  q:    text('q').primaryKey(),
  tags: text('tags').notNull(),   // JSON-массив английских тегов
  src:  text('src'),              // lexical | embed
  at:   integer('at').notNull(),  // ms, Date.now()
}, (t) => ({
  atIdx: index('idx_ru_qcache_at').on(t.at),
}));

// Дебаунс инлайна: последний запрос пользователя — 500 мс покоя до отправки в модель.
export const inlineSeen = table('inline_seen', {
  userId: integer('user_id').primaryKey(),
  q:      text('q').notNull(),
  at:     integer('at').notNull(), // ms, Date.now()
});

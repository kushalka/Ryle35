# Источники контента: API и куки-сессии

Составлено: 2026-10-09. Проверка живости curl-ом с этой машины: `200` = жив, `403` = жив (Cloudflare режет бота), `000` = с этой машины не достучаться — это сетевая блокировка (РКН/прокси), а не смерть сайта, для бота нужен прокси. Отдельно помечены нестабильные.

**Прокси (проверено 2026-10-09):** рабочий локальный HTTP-прокси — `http://127.0.0.1:8408` (запасные: `127.0.0.1:3990`, `127.0.0.1:25916`). Через него отвечают **все** сайты из списка, кроме behoimi.org, lolibooru.moe и baraag.io (реально недоступны/нестабильны), а rule34hentai.net и корень rule34.xxx отдают 403 (Cloudflare — лечится браузерным UA и/или cf_clearance). Боту: `curl -x http://127.0.0.1:8408 ...` или `HTTPS_PROXY=http://127.0.0.1:8408`.

**Куки/ключи:** собранные сессии лежат в `booru_tokens.json` (формат: cookies CDP для каждого сайта; файл локальный, в репозиторий не входит). Ключей API пока нет — все требуют залогиненного аккаунта.

---

## 1. Danbooru-совместимые (REST, JSON) — самый удобный формат

| Сайт | Базовый запрос | Авторизация | Примечание |
|---|---|---|---|
| **Danbooru** `danbooru.donmai.us` | `GET /posts.json?tags=...&limit=200&login=X&api_key=Y` | api_key (в профиле, бесплатно) | эталон API; аноним ~10 req/s, Gold/Platinum больше. Доки: `/wiki_pages/help:api` |
| Safebooru (донмай) `safebooru.donmai.us` | то же, без ключа | не нужна | SFW-зеркало danbooru |
| **AIBooru** `aibooru.online` | `GET /posts.json?tags=...` | опционально | боору AI-арта, API как у danbooru. Жив, но **исключён из бота 2026-10-10** — целиком AI-контент (владелец: AI не показывать) |
| **e621** `e621.net` | `GET /posts.json?tags=...&login=X&api_key=Y` | api_key (профиль → API Access) | фурри; **User-Agent обязателен** (иначе 403), лимит 2 req/s. `e926.net` — то же, SFW-фильтр |
| **e6ai** `e6ai.net` | `GET /posts.json` | опционально | фурри AI-арт, движок e621. Жив, но **исключён из бота 2026-10-10** — целиком AI-контент |

## 2. Gelbooru 0.2 «dapi» (XML/JSON)

| Сайт | Базовый запрос | Авторизация | Примечание |
|---|---|---|---|
| **Gelbooru** `gelbooru.com` | `GET /index.php?page=dapi&s=post&q=index&json=1&api_key=KEY&user_id=ID` | api_key + user_id (бесплатная регистрация, выдаются в «Options → API Access») | без ключа API почти закрыт |
| **Safebooru.org** `safebooru.org` | `GET /index.php?page=dapi&s=post&q=index&json=1&tags=...` | не нужна | SFW-клон гелбоору |
| **Rule34.xxx** `api.rule34.xxx` | `GET https://api.rule34.xxx/index.php?page=dapi&s=post&q=index&json=1&limit=1000&tags=...` | чтение без ключа; cookie `PHPSESSID` для аккаунта | жив ✅, самый ходовой источник R34 |
| Xbooru `xbooru.com` | `GET /index.php?page=dapi&s=post&q=index&json=1` | не нужна | |
| HypnoHub `hypnohub.net` | `GET /index.php?page=dapi&s=post&q=index` | не нужна | |
| **Семейство booru.org** | `GET https://<имя>.booru.org/index.php?page=dapi&s=post&q=index` | не нужна | десятки мелких боору на одном движке: `furry.booru.org`, `3ds.booru.org` и т.д. (Gelbooru Beta 0.1.11, чаще XML без json=1) |

## 3. Moebooru (`/post.json`)

| Сайт | Базовый запрос | Авторизация | Примечание |
|---|---|---|---|
| **Konachan** `konachan.com` | `GET /post.json?tags=...&page=1&limit=100` | не нужна (cookie/логин для избранных) | SFW-версия — `konachan.net` (жив ✅) |
| **yande.re** | `GET /post.json?tags=...` | не нужна | скрины/арты высокого качества |
| Sakugabooru `sakugabooru.com` | `GET /post.json?tags=...` | не нужна | анимационные сакуги. Жив ✅ |
| Lolibooru `lolibooru.moe` | `GET /post.json?tags=...` | не нужна | статус нестабилен, проверять перед использованием |
| 3dbooru (Behoimi) `behoimi.org` | `GET /post.json?tags=...` | не нужна | **нестабилен** (периодический 503); на картинки нужен заголовок `Referer: http://behoimi.org/post/show/` |

## 4. Shimmie2 (danbooru-совместимый эндпоинт)

| Сайт | Базовый запрос | Авторизация | Примечание |
|---|---|---|---|
| **Rule34 Paheal** `rule34.paheal.net` | `GET /api/danbooru/find_posts?tags=...` | не нужна | крупный R34-аггрегатор |
| Rule34Hentai `rule34hentai.net` | `GET /index?q=api/danbooru/find_posts&tags=...` | не нужна | R34-контент, видео в т.ч. |

## 5. Philomena (MLP + общее)

| Сайт | Базовый запрос | Авторизация | Примечание |
|---|---|---|---|
| Derpibooru `derpibooru.org` | `GET /api/v1/json/search/images?q=...&key=KEY` | ключ опционален (нужен для матовых фильтров) | жив ✅ |
| Manebooru `manebooru.org` | `GET /api/v1/json/search/images?q=...` | не нужна | жив ✅ |
| Twibooru `twibooru.org` | `GET /api/v1/json/search/images?q=...` | не нужна | жив ✅ |
| Ponybooru `ponybooru.org` | `GET /api/v1/json/search/images?q=...` | не нужна | жив ✅ |

## 6. Проприетарные API / внутренние JSON

| Сайт | API | Авторизация | Примечание |
|---|---|---|---|
| **Sankaku Complex** `chan.sankakucomplex.com` | `POST https://capi-v2.sankakucomplex.com/auth/token` (login+password) → Bearer; `GET /posts?tags=...` | **логин обязателен** (с 2024 почти всё за аккаунтом); для веба — cookie | жив ✅ (API отвечает 403 без токена) |
| **Zerochan** `zerochan.net` | `GET https://www.zerochan.net/<тег>?json=1&s=id&l=150` | без ключа; логин-сессия поднимает лимиты | жив ✅ |
| **Anime-Pictures** `anime-pictures.net` | `GET https://api.anime-pictures.net/api/v3/posts?page=0&search_tag=...` | не нужна | жив ✅ |
| **Wallhaven** `wallhaven.cc` | `GET /api/v1/search?q=...&apikey=KEY` | ключ бесплатный, обязателен для NSFW | жив ✅, официальные доки |
| **Kemono** `kemono.cr` | `GET https://api.kemono.cr/v1/<service>/<автор>/posts` (service: patreon, fanbox, subscribestar, fa, dlsite…) | чтение без ключа; cookie `session` для аккаунта | пейволовский контент; зеркало `kemono.su`. Жив ✅ |
| **Coomer** `coomer.st` | `GET https://coomer.st/api/v1/<service>/<автор>/posts` (onlyfans, fansly) | не нужна для чтения | тот же движок, что kemono. Жив ✅ |
| r34.app | свой JSON API (обёртка над rule34.xxx/红) | не нужна | живость под вопросом (с машины не достучаться) |
| Rule34Video `rule34video.com` | HTML + внутренние JSON, без ключей | не нужна | видео |
| **nhentai** `nhentai.net` | `GET /api/gallery/<id>`, `GET /api/galleries/search?query=...&page=1` | не нужна, но за Cloudflare — иногда нужен cookie `cf_clearance` | |
| **E-hentai** `e-hentai.org` | `POST https://api.e-hentai.org/api.php` (method=gdata, метаданные галерей) | не нужна | **ExHentai**: те же методы, но нужны cookies `ipb_member_id` + `ipb_pass_hash` от форума. Жив ✅ |
| Hitomi `hitomi.la` | `https://ltn.hitomi.la/galleries/<id>.js` + `gg.js` для сборки ссылок на картинки | не нужна | своеобразный, но рабочий формат |
| IMHentai `imhentai.xxx` | внутренний JSON, за Cloudflare | cookie `cf_clearance` | |
| Hanime.tv | `https://api.hanime.tv/v8/...` | cookie сессии (нестабильно, без гарантий) | видео |
| MangaDex `api.mangadex.org` | `GET /manga?title=...` | публично; OAuth для личных списков | официальный API |
| Scrolller `scrolller.com` | `POST https://api.scrolller.com/graphql` | не нужна (нужен браузерный UA) | жив ✅, GraphQL |

## 7. Только куки (официального API нет — логинишься в браузере, вытаскиваешь cookie)

| Сайт | Куки | Примечание |
|---|---|---|
| **FurAffinity** `furaffinity.net` | `a` и `b` (после логина) + включить Adult в настройках | парсинг HTML, готовые обёртки есть на GitHub |
| **Pixiv** `pixiv.net` | `PHPSESSID` (или OAuth refresh_token для app-api) | веб-API: `GET https://www.pixiv.net/ajax/search/artworks/<слово>?order=date_d` (JSON); картинки с `i.pximg.net` требуют заголовок `Referer: https://www.pixiv.net/` |
| ExHentai `exhentai.org` | `ipb_member_id` + `ipb_pass_hash` | без кук — «sad panda». Жив ✅ |
| Sankaku (веб-часть) | session cookie | для всего кроме API-токена |
| E-shuushuu `e-shuushuu.net` | — | жив ✅, только HTML-парсинг, API нет |
| JoyReactor / anime.reactor.cc | — | HTML-парсинг |

## 8. Арт-платформы с официальными API

| Сайт | API | Авторизация |
|---|---|---|
| **Inkbunny** `inkbunny.net` | `GET /api_login.cgi?username=X&password=Y` → `sid`, затем `/api_search.cgi?sid=...` | логин/пароль (официальный API) |
| **Weasyl** `weasyl.com` | `GET /api/submissions/...`, заголовок `X-Weasyl-API-Key: KEY` | API-ключ из профиля. Жив ✅ |
| **Itaku** `itaku.ee` | `GET https://itaku.ee/api/posts/?...` | публично, ключ для личного. Жив ✅ |
| DeviantArt `deviantart.com` | OAuth2 → `https://www.deviantart.com/api/v1/oauth2/...` | client_id/secret; для mature-контента нужен логин-токен |
| ArtStation `artstation.com` | внутренний JSON `POST https://www.artstation.com/api/v2/search/projects.json` | без ключа, но API неофициальный |
| Baraag `baraag.net` / Pawoo `pawoo.net` | Mastodon API (`/api/v1/timelines/...`) | токен приложения |

---

## 9. Новые кандидаты (проверено 2026-10-10, curl через прокси 3990)

| Сайт | Движок / API | Статус | Примечание для бота |
|---|---|---|---|
| **TBIB** `tbib.org` | gelbooru dapi, `json=1` работает | жив ✅, 8М+ постов | в ответе нет `file_url` — собирать из `directory/hash/image` (`/images/{dir}/{hash}/{image}`); мелкий хак dapi-парсера. Крупнейший аггрегатор |
| **Rule34 Paheal** `rule34.paheal.net` | shimmie `/api/danbooru/find_posts` | жив ✅, 6.5М постов | ответ XML; `file_url` без расширения (реальное — в `file_name`); мини-парсер |
| **Furbooru** `furbooru.org` | philomena `/api/v1/json/search/images` | жив ✅, 278k | фурри; общий philomena-парсер на всё семейство (derpibooru/manebooru/twibooru/ponybooru из §5) |
| **Ponerpics** `ponerpics.org` | philomena | жив ✅ | то же, MLP |
| **e926** `e926.net` | e621 fmt `/posts.json` | жив ✅ | дубль e621 с SFW-фильтром — крауллить смысла нет |
| MSPA booru `mspabooru.com` | gelbooru 0.1 dapi | жив ✅ | ниша Homestuck, `file_url` собирать как tbib; низкий приоритет |
| ATFbooru `booru.allthefallen.moe` | danbooru | жив, но антибот-страница «Verification» вместо JSON | боту не подходит без браузерных кук |
| rule34.us | gelbooru dapi | API закрыт — на dapi отдаёт HTML | не использовать |
| wh40kart.im | shimmie | `/api/danbooru/find_posts` → 404 | не использовать |

Итог 2026-10-10: лучшие добавления — **tbib.org**, **rule34.paheal.net** (оба дают миллионы постов), плюс **sankaku** (токен уже в booru_tokens.json) и philomena-семейство, если нужен пони/фурри контент.

## 10. Подключены к боту — 21 сайт (движки в endpoints/crawl.js, набор 2026-10-10)

AI-контент не индексируется (владелец, 2026-10-10): isAiTag в crawl.js режет посты с AI-тегами (`ai_generated`, `ai-generated`, `ai`, `stable_diffusion`, `novelai`, … — список в коде); aibooru.online и e6ai.net исключены вовсе — целиком AI.

**Движки (fmt):** danbooru | e621 | dapi (gelbooru 0.2, JSON) | dapiXml (gelbooru 0.1 — ссылки только в XML: tbib, mspa) | moebooru | wallhaven (ключ) | r34world (свой POST /api/v2) | shimmie (/api/danbooru/find_posts, XML — paheal) | philomena (/api/v1/json/search/images).

| Сайт | fmt | Сайт | fmt |
|---|---|---|---|
| danbooru.donmai.us | danbooru | wallhaven.cc | wallhaven+ключ |
| safebooru.donmai.us | danbooru | rule34.world | r34world |
| rule34.paheal.net | shimmie | derpibooru.org | philomena |
| e621.net | e621 | manebooru.org | philomena |
| rule34.xxx | dapi+ключ | ponybooru.org | philomena |
| gelbooru.com | dapi+ключ | furbooru.org | philomena |
| safebooru.org | dapi | ponerpics.org | philomena |
| xbooru.com | dapi | tbib.org | dapiXml |
| mspabooru.com | dapiXml | konachan.com / .net | moebooru |
| yande.re | moebooru | sakugabooru.com | moebooru |

**rule34.world** — не gelbooru: свой Angular-SPA API. Поиск `POST https://rule34.world/api/v2/post/search/root` с телом `{"includeTags":["1girl"],"take":100}` (+ `cursor` из ответа для следующих страниц, курсор — **строка**, числом API отвечает 400; сервер берёт максимум 3 тега, неизвестные теги молча игнорирует). Элементы выдачи без тегов и ссылок — только id/width/height/type (0=картинка, 1=видео); ссылки собираются по шаблону CDN `https://rule34storage.b-cdn.net/posts/<id/1000 целым>/<id>/<id>.pic.jpg` (картинка), `.pic256.jpg` (превью), `.mov.mp4` (видео; его миниатюра — `.mov256.mp4`). ⚠️ 2026-10-10 вечер: прежний шаблон `/posts/<id>/1000/<id>...` (число 1000 в пути) умер — все 2485 постов в БД с мёртвыми URL; Типы файлов из кода фронта: Pic=10, PicThumbnail=11, Mov=100, Mov720=113 и т.д. Теги постов = теги запроса (как wallhaven); полные теги отдаёт только одиночный `GET /api/v2/post/<id>` (он же — эхо-проверка), размера файла нет нигде (доступен только HEAD'ом по CDN-URL).

**Особенности поиска 2026-10-10:** konachan.com не ищет по тегам с цифры в начале (`1girl` пусто, хотя тег есть с count=307) — их баг, остальные теги работают; yande.re вычистил теги `1girl`/`girl` из корпуса (пусто и в tag.json); mspabooru жив, но корпуса тегов гомстаковские (`1girl` → 0); XML у paheal в одинарных кавычках, у tbib — в двойных (парсер xmlAttrs ест оба).

**Не добавлены (проверено 2026-10-10):** e926 — 403 на egress Telegram (с прокси работает); hypnohub — dapi отдаёт 0 на любой тег после переезда движка; twibooru — сайт жив, API закрыт (все /api/* → 404); rule34hentai.net — 403 Cloudflare с любых наших IP; sankaku — токен из booru_tokens.json истёк + capi-v2 банит IP прокси (нужен свежий логин браузером).

**Обход всех оставшихся кандидатов (вечер 2026-10-10, локально через прокси 25916/3990 + пробы из облака (tgcloud run)): добавить нечего.**

| Кандидат | Вердикт |
|---|---|
| anime-pictures.net | API v3 жив, теги с пробелами (`long hair`), превью `_sp.png` хотлинкается — но **оригиналы** (`oimages.anime-pictures.net/<md5[:3]>/<file_url из детального запроса>`) редиректят на главную без своей сессии — хотлинк-гейт, для инлайна мёртв |
| zerochan.net | JS-челлендж «Checking browser…» **привязан к IP**: свежие куки с решённым в браузере челленджем (клиренс-кука `xbotcheck`, снята через 37777) проходят локально через прокси, но из облака TG-egress всё равно 503 — у egress пул IP, челлендж не решить. Куки в keys.js (`zerochan`) остаются про запас |
| realbooru.com | dapi отвечает: «API offline… shut off indefinitely» |
| sankaku | **IP-блок, а не авторизация**: даже с полной сессией из booru_tokens.json (Bearer из cookie access_token + все 10 кук, экспортёр `_sk_export.js` → keys.js) capi-v2 из облака отвечает голым nginx-403 — sankaku режет датацентровые диапазоны целиком, TG-egress непроходим в принципе |
| rule34.xyz, rule34vault.com, yiffverse.com | тот же движок `POST /api/v2/post/search/root` + CDN семейства `r34xyz.b-cdn.net` — копии rule34.world |
| rule34.gg | свой SPA (`new-api.rule34.gg` в токенах), открытого API не найдено; rule34.porn — HTML-туба |
| firebooru.com | мёртв (502 локально, fetch fail из облака) |
| booru.borvar.art (danbooru-инстанс) | Cloudflare «Just a moment» |
| семейство booru.org (furry/ecchi/…) | поглощено tbib: file_url у furry.booru.org указывают на tbib.org — зеркало уже подключённого tbib |
| idolcomplex.com | React-SPA, dapi выпилен; agn.ph — API не найдено; lolibooru/behoimi — недоступны; scatbooru/sizebooru/moepire — ниши без стоимости адаптера |
| Ленты/каталоги вне бооров (kemono, e-shuushuu, oreno3d, hentai-foundry, iwara) | не бооры: без тегового поиска, HTML или платный анти-скрейп — не трогали |

## Практические заметки

- **e621/e926**: без своего `User-Agent` — 403. Ставь осмысленный UA во все клиенты.
- **Лимиты**: danbooru ~10 req/s (аноним), e621 жёстко 2 req/s, kemono банит за параллельный скрейп. Безопасная ставка для всех — 1–2 req/s.
- **Ключи бесплатны** и берутся за минуту: danbooru, gelbooru, e621, wallhaven — в настройках профиля; sankaku — просто аккаунт; kemono — cookie `session` после логина.
- **Cloudflare**: nhentai, imhentai, периодически gelbooru — обычным requests не пробиться, нужен `cf_clearance` из браузера или curl-cffi/Playwright.
- **Статус аккаунтов (2026-10-09, ночь)**: в `booru_tokens.json` готовые ключи/сессии: **danbooru** (ключ `ryle35`), **pixiv** (PHPSESSID после входа через Google), **furaffinity** (аккаунт создан, куки a/b), **sankaku** (токен), плюс из BotGG: **aibooru**, **ponerpics**, **rule34.xxx**, **rule34.porn**, **rule34.gg**, **civitai**, **deviantart**. **e621**: аккаунт создан, ждёт письма-подтверждения. **e-hentai**: форма регистрации заполнена, ждёт капчу reg_code от владельца. **gelbooru/wallhaven** — регистрации закрыты на сервере.
- **Что уже полезно в файле**: `cf_clearance` для rule34.xxx, konachan.com и pixiv — работает как обход Cloudflare при совпадении IP (прокси) и User-Agent с браузером.
- **Начальный набор для бота**: danbooru + gelbooru + rule34.xxx + konachan + yande.re + e621 + safebooru — покрывают 90% артов, у всех простой JSON-ответ без капч. Анонимно API работают у danbooru, rule34.xxx, safebooru.org, konachan, yande.re, e621 (с ключами — выше лимиты и избранное).

---

## 11. Расширение 2026-10-20 — галереи, арт-платформы, агрегаторы (+6 сайтов, всего 27)

Добавлены после проверки на **хотлинк без Referer** (жёсткое условие инлайна: Telegram тянет `file_url` серверно, без заголовка Referer). Порядок вердиктов — сверка живыми запросами (UA `Ryle35InlineBot/1.0`), не по документации.

### Добавлено (fmt в `endpoints/crawl.js`)

| Сайт | fmt | cd | Что и как | Ключ/сессия |
|---|---|---|---|---|
| **nhentai** `nhentai.net` | `nhentai` | 120 | v2-API. Старый `/api/galleries/search` теперь 403 «Use new API». `/api/v2/search?query=&page=` (аноним 10/мин) — листинг без `fileUrl`, только `media_id` и путь превью `galleries/<mid>/thumb[.<orig>].webp`; страница-1 = `1.<orig>` (thumb.jpg.webp → 1.jpg, thumb.webp → 1.webp — сверено). Зеркала i1..i4/t1..t4 равнозначны. Теги: `tag_ids` → один `/api/v2/tags/ids`. Теги — слова через пробел (подчёркивания → 0). Хотлинк 200 image/webp. | нет |
| **e-hentai** `e-hentai.org` | `ehentai` | 600 | У `api.php` только `gdata` (method=search нет). Поиск — HTML `/?f_search=`, пагинация курсором `next=<gid>`. Пары gid/token из выдачи → один POST `gdata` (≤25 gid) → метаданные/теги/обложка. `fileUrl` = обложка `ehgt.org` (стабильная, хотлинк 200 image/webp). **Ссылку на полную страницу не строим**: её URL живёт с `keystamp` и нестандартным портом `hath.network` и протухает. Теги с неймспейсом (language:/artist:/) — срезаем префикс. | нет (ExHentai — куки, не берём) |
| **itaku** `itaku.ee` | `itaku` | 300 | DRF cursor-пагинация; `limit`/`page` API игнорит (всегда 15), реальный фильтр — `required_tags` (AND, повторяемый), а `tags=` молча игнорится. Один пост = несколько `gallery_images` → строка на файл. Статика → `image_xl` (≤4.2 МБ), анимация → `image` (image_xl битый). Хотлинк 200 image/png. | нет |
| **scrolller** `scrolller.com` | `scrolller` | 900 | Живой GraphQL-путь — `POST https://api.scrolller.com/admin` (`/graphql` → 301). Тег → `searchSubreddits` → 4 саба → `getSubreddit`. Медиа: `mediaSources[]`; JPEG (images.scrolller.com) / MP4 (octa.scrolller.com). Хотлинк 200 без Referer. Боорного тега нет — маппинг на имя сабреддита. | нет |
| **FurAffinity** `furaffinity.net` | `furaffinity` | 900 | API нет — HTML-поиск (`<figure id="sid-<id>">`, `data-tags`). Файлы/превью `t./d.furaffinity.net` — 200 без Referer и без кук. perpage ≤48. Анонимно — general/questionable, adult скрыт. | не нужны |
| **DeviantArt** `deviantart.com` | `deviantart` | 900 | OAuth2 app-токен (client_credentials, 1 ч, кэш в модуле). `/browse/tags?tag=` принимает **ровно один** тег (мульти → 400). `content.src` — подписанный CDN-URL, хотлинк 200 без Referer (без токена 401). | `keys.js → deviantart` |

### Отклонено (проверено живьём)

| Сайт | Причина |
|---|---|
| **pixiv.net** | Картинки только на `i.pximg.net`, который требует `Referer: https://www.pixiv.net/` (без него 403, с ним 200). Инлайн ТГ шлёт без Referer ⇒ мёртв. Поиск работает, но ссылки ведут на тот же CDN. |
| **hitomi.la** | То же — CDN отдаёт файл только с `Referer: https://hitomi.la/` (без него 404). Основной домен `ltn.hitomi.la` не резолвится; рабочий двойник `ltn.gold-usergeneratedcontent.net`. Поиск (nozomi) жив, но картинки для инлайна недоступны. |
| **kemono.cr / coomer.st** | API и превью (`img.kemono.cr`) живут, но `fileUrl` ведёт на `n1-n4.kemono.cr` (общий кластер, 91.149.227.10-13) — ни одного открытого TCP-порта, connect timeout из всех проверенных сетей (direct, прокси, SOCKS, 6 стран). Хотлинк не пройден. |
| **artstation.com** | API и хотлинк 200, но выдача — только `smaller_square_cover_url` 400×400, **тегов в ответе нет** ⇒ AI-контент (ArtStation завален им) отсечь нечем — нарушает правило владельца «AI не индексировать». |
| **inkbunny.net** | Официальный API требует логин/пароль, кред в репозитории нет, гостевого режима нет. |
| **zerochan.net** | CDN хотлинкается (200 image/jpeg), `json=1` отдаёт items даже без кук, но JS-челлендж «Checking browser…» привязан к IP и режет датацентровые диапазоны TG-egress (503). |

**Уроки:** (1) для инлайна критичен только один тест — `curl` на `file_url` без Referer: 200 + image/video + size>0; всё остальное вторично. (2) У gallery-сайтов (nhentai/e-hentai) листинг не даёт `fileUrl` — надо собирать из `media_id`/обложки, а полные URL с `keystamp` в БД не класть (протухают). (3) `tags=` у itaku и `perpage`/мульти-тег у DA/FA — тихие no-op'ы: проверять negative control (nonsense-тег должен давать пусто).

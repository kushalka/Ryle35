// tgcloud/lib/ru.js — перевод русского поискового запроса в английские боору-теги.
//
// Три слоя, от дешёвого к дорогому:
//   1) кэш ru_qcache  — тот же текст не эмбеддится повторно (TTL 30 с);
//   2) лексика        — встроенный словарь частых русских слов/фраз;
//   3) семантика      — embedQuery() + косинус по tag_vec (только если лексика
//                       дала меньше 2 тегов).
//
// Ограничения изолята: нет process.env и нет setTimeout/setInterval — пауз нет,
// только Date.now(). База ограничена лимитом rows_read, поэтому tag_vec читаем
// одним запросом ORDER BY n DESC LIMIT 2500 (индекс idx_tag_vec_n).
//
// Модуль НИКОГДА не бросает исключение: при любом провале возвращает то, что
// успела дать лексика (возможно пустой массив).

import { db } from 'sdk';
import { embedQuery, cosineInt8 } from './embed.js';

const CACHE_TTL_MS = 30000;   // свежесть записи ru_qcache (как cache_time инлайна)
const LEX_MIN_TAGS = 2;       // меньше — идём в семантику
const VEC_TOP_K = 2500;       // сколько векторов tag_vec читать (лимит rows_read)
const EMBED_TOP_N = 12;       // жёсткий потолок тегов из семантики
// Порог косинуса для семантического слоя. Перекалиброван на полном tag_vec
// (54 630 строк, чанкованный проход, 2026-10-20): верные теги чётких запросов
// дают 0.13–0.33 (dragon 0.265, elf 0.181, samurai 0.176, long_hair 0.135),
// шум на слабых запросах («лис», «школьница») уходит выше 0.14 и не отделяется
// порогом — его режет относительная отсечка (REL_DELTA) и adult-фильтр.
const SIM_THRESHOLD = 0.14;
// Относительная отсечка: тег держим, только если его косинус >= (лучший − DELTA).
// Без этого на 54k строк EMED_TOP_N всегда набирался мусором вокруг лучшего
// совпадения (кот → 9 вариантов coat, лис → licking/lipstick/lion).
const REL_DELTA = 0.06;

// ─── Adult-фильтр семантической выдачи ──────────────────────────────────────
// Семантика угадывает теги по смыслу; угаданные explicit-теги (кошкодевочка →
// cumshot, эльфийка → ejaculation) в инлайн попадать не должны. Матчим по
// сегментам тега (split по не-буквам), не по подстроке: 'anal' ≠ 'banana',
// 'cock' ≠ 'peacock'. Дополнительно — известные префиксы словоформ.
const ADULT_SEGMENTS = new Set([
  'cum', 'cumshot', 'bukkake', 'ejaculation', 'penis', 'cock', 'dick', 'pussy',
  'vagina', 'anal', 'sex', 'sex_from_behind', 'blowjob', 'fellatio', 'dildo',
  'masturbation', 'fuck', 'porn', 'hentai', 'nude', 'nudes', 'naked',
  'nipples', 'areolae', 'areola', 'erection', 'testicles', 'groin', 'crotch',
  'rape', 'orgasm', 'gangbang', 'defloration', 'deepthroat', 'cunnilingus',
  // E2E 2026-10-21 (kanban t_e427d0c8): панда → panties/pantsu/panty_pull,
  // тигрица → tentacles, ведьма → vore — добор по живым промахам фильтра.
  'panties', 'pantsu', 'panty', 'tentacle', 'tentacles', 'vore', 'bondage',
]);
const ADULT_PREFIXES = ['ejaculat', 'penetrat', 'masturbat', 'fuck'];

function isAdultTag(tag) {
  const segs = String(tag).toLowerCase().split(/[^a-z]+/);
  for (const seg of segs) {
    if (!seg) continue;
    if (ADULT_SEGMENTS.has(seg)) return true;
    for (const p of ADULT_PREFIXES) {
      if (seg.startsWith(p)) return true;
    }
  }
  return false;
}

// ─── Нормализация запроса ────────────────────────────────────────────────────

// Нижний регистр, ё→е, подчёркивания и любые пробельные серии → один пробел, обрезка.
export function normalizeRu(text) {
  let s = String(text == null ? '' : text).toLowerCase();
  s = s.replace(/ё/g, 'е');
  s = s.replace(/_/g, ' ');
  s = s.replace(/\s+/g, ' ');
  return s.trim();
}

// ─── Лёгкий русский стеммер (только для сопоставления в словаре) ─────────────
// Отбрасываем частые окончания, от длинных к коротким; корень не короче 3 букв.
// Это даёт устойчивость к падежам: «дождь/дождём/дожди» → «дожд», «кошка/кошке/кошкой» → «кошк».
const RU_SUFFIXES = [
  'иями', 'ями', 'ами', 'иях', 'ях', 'ах', 'ыми', 'ими', 'ого', 'его', 'ому', 'ему',
  'ов', 'ев', 'ий', 'ый', 'ой', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ых', 'их',
  'ым', 'им', 'ом', 'ем', 'ей', 'ую', 'юю',
  'ы', 'и', 'а', 'я', 'е', 'у', 'ю', 'о', 'ь',
];

function stemRu(word) {
  let s = word;
  for (let i = 0; i < RU_SUFFIXES.length; i++) {
    const suf = RU_SUFFIXES[i];
    if (s.endsWith(suf) && s.length - suf.length >= 3) return s.slice(0, -suf.length);
  }
  return s;
}

// ─── Лексический словарь ─────────────────────────────────────────────────────
// Русское слово/фраза → английский боору-тег (или массив тегов).
// Ключи — в нормализованном виде (нижний регистр, ё→е, пробелы).
const LEX = {
  // люди и персонажи
  'девушка': '1girl',
  'девочка': '1girl',
  'женщина': '1girl',
  'леди': '1girl',
  'дама': '1girl',
  'парень': '1boy',
  'мужчина': '1boy',
  'юноша': '1boy',
  'мальчик': '1boy',
  'джентльмен': '1boy',
  'девушки': 'multiple_girls',
  'несколько девушек': 'multiple_girls',
  'толпа': 'crowd',
  'один': 'solo',
  'одна': 'solo',
  'соло': 'solo',
  'в одиночестве': 'solo',
  'пара': 'couple',
  'вдвоем': 'couple',
  'вместе': 'together',
  'семья': 'family',
  'семейство': 'family',
  'ребенок': 'child',
  'дети': 'child',
  'малыш': 'child',
  'младенец': 'baby',
  'грудной ребенок': 'baby',
  'старик': 'old_man',
  'дед': 'old_man',
  'пожилой мужчина': 'old_man',
  'старуха': 'old_woman',
  'бабушка': 'old_woman',
  'пожилая женщина': 'old_woman',

  // волосы
  'волосы': 'long_hair',
  'длинные волосы': 'long_hair',
  'короткие волосы': 'short_hair',
  'стрижка': 'short_hair',
  'блондин': 'blonde_hair',
  'блондинка': 'blonde_hair',
  'светлые волосы': 'blonde_hair',
  'брюнет': 'black_hair',
  'брюнетка': 'black_hair',
  'черные волосы': 'black_hair',
  'рыжий': 'red_hair',
  'рыжая': 'red_hair',
  'рыжие волосы': 'red_hair',
  'рыжеволосая': 'red_hair',
  'рыжая девушка': ['1girl', 'red_hair'],
  'рыжий парень': ['1boy', 'red_hair'],
  'шатен': 'brown_hair',
  'шатенка': 'brown_hair',
  'каштановые волосы': 'brown_hair',
  'синие волосы': 'blue_hair',
  'голубые волосы': 'blue_hair',
  'розовые волосы': 'pink_hair',
  'зеленые волосы': 'green_hair',
  'фиолетовые волосы': 'purple_hair',
  'белые волосы': 'white_hair',
  'седые волосы': 'white_hair',
  'серые волосы': 'grey_hair',
  'серебристые волосы': 'silver_hair',
  'разноцветные волосы': 'multicolored_hair',
  'хвостики': 'twintails',
  'два хвоста': 'twintails',
  'хвост': 'ponytail',
  'конский хвост': 'ponytail',
  'коса': 'braid',
  'косички': 'braid',
  'заплетенные волосы': 'braid',
  'пучок': 'bun',
  'шиньон': 'bun',
  'челка': 'bangs',
  'ахохе': 'ahoge',
  'торчащий волос': 'ahoge',
  'волосы между глаз': 'hair_between_eyes',
  'волосы на один глаз': 'hair_over_one_eye',
  'волнистые волосы': 'wavy_hair',
  'кудри': 'curly_hair',
  'кудрявые волосы': 'curly_hair',
  'прямые волосы': 'straight_hair',

  // глаза и лицо
  'голубые глаза': 'blue_eyes',
  'синие глаза': 'blue_eyes',
  'зеленые глаза': 'green_eyes',
  'карие глаза': 'brown_eyes',
  'коричневые глаза': 'brown_eyes',
  'красные глаза': 'red_eyes',
  'фиолетовые глаза': 'purple_eyes',
  'желтые глаза': 'yellow_eyes',
  'гетерохромия': 'heterochromia',
  'разный цвет глаз': 'heterochromia',
  'улыбка': 'smile',
  'улыбается': 'smile',
  'открытый рот': 'open_mouth',
  'закрытые глаза': 'closed_eyes',
  'плачет': 'crying',
  'слезы': 'tears',
  'румянец': 'blush',
  'смущение': 'blush',
  'злой': 'angry',
  'злость': 'angry',
  'гнев': 'angry',
  'грустный': 'sad',
  'грусть': 'sad',
  'печаль': 'sad',
  'счастливый': 'happy',
  'радость': 'happy',
  'удивленный': 'surprised',
  'серьезный': 'serious',
  'веснушки': 'freckles',
  'макияж': 'makeup',
  'помада': 'lipstick',
  'борода': 'beard',
  'усы': 'mustache',
  'очки': 'glasses',
  'солнечные очки': 'sunglasses',
  'темные очки': 'sunglasses',
  'маска': 'mask',
  'пирсинг': 'piercing',
  'татуировка': 'tattoo',
  'шрам': 'scar',
  'родинка': 'mole',

  // одежда и аксессуары
  'платье': 'dress',
  'юбка': 'skirt',
  'рубашка': 'shirt',
  'штаны': 'pants',
  'брюки': 'pants',
  'шорты': 'shorts',
  'купальник': 'swimsuit',
  'бикини': 'bikini',
  'нижнее белье': 'underwear',
  'белье': 'lingerie',
  'чулки': 'stockings',
  'носки': 'socks',
  'сапоги': 'boots',
  'туфли': 'shoes',
  'обувь': 'shoes',
  'ботинки': 'shoes',
  'сандалии': 'sandals',
  'босоножки': 'sandals',
  'кроссовки': 'sneakers',
  'шляпа': 'hat',
  'кепка': 'cap',
  'бейсболка': 'cap',
  'перчатки': 'gloves',
  'шарф': 'scarf',
  'ожерелье': 'necklace',
  'колье': 'necklace',
  'сережки': 'earrings',
  'серьги': 'earrings',
  'кольцо': 'ring',
  'часы': 'watch',
  'сумка': 'bag',
  'рюкзак': 'backpack',
  'зонт': 'umbrella',
  'зонтик': 'umbrella',
  'кимоно': 'kimono',
  'юката': 'yukata',
  'школьная форма': 'school_uniform',
  'костюм': 'suit',
  'доспехи': 'armor',
  'броня': 'armor',
  'шлем': 'helmet',
  'плащ': 'cape',
  'накидка': 'cape',
  'корона': 'crown',
  'диадема': 'tiara',
  'вуаль': 'veil',
  'крылья': 'wings',
  'ангельские крылья': 'angel_wings',
  'демонические крылья': 'demon_wings',
  'рога': 'horns',
  'кошачьи уши': 'cat_ears',
  'ушки кошки': 'cat_ears',
  'лисьи уши': 'fox_ears',
  'заячьи уши': 'bunny_ears',
  'звериные уши': 'animal_ears',
  'звериный хвост': 'animal_tail',

  // животные и существа
  'кошка': 'cat',
  'кот': 'cat',
  'котик': 'cat',
  'собака': 'dog',
  'пес': 'dog',
  'щенок': 'dog',
  'волк': 'wolf',
  'волчица': 'wolf',
  'лиса': 'fox',
  'лисица': 'fox',
  'лисичка': 'fox',
  'лисёнок': 'fox',
  'котёнок': 'cat',
  'тигрица': 'tiger',
  'львица': 'lion',
  'кролик': 'rabbit',
  'заяц': 'rabbit',
  'птица': 'bird',
  'птичка': 'bird',
  'рыба': 'fish',
  'рыбка': 'fish',
  'лошадь': 'horse',
  'конь': 'horse',
  'лев': 'lion',
  'тигр': 'tiger',
  'медведь': 'bear',
  'панда': 'panda',
  'дракон': 'dragon',
  'единорог': 'unicorn',
  'русалка': 'mermaid',
  'змея': 'snake',
  'лягушка': 'frog',
  'мышь': 'mouse',
  'хомяк': 'hamster',
  'бабочка': 'butterfly',
  'пчела': 'bee',
  'паук': 'spider',
  'сова': 'owl',
  'кошкодевочка': 'cat_girl',
  'девушка-кошка': 'cat_girl',
  'девушка-лиса': 'fox_girl',

  // природа и погода
  'закат': 'sunset',
  'рассвет': 'sunrise',
  'восход': 'sunrise',
  'ночь': 'night',
  'ночной': 'night',
  'день': 'day',
  'дневной': 'day',
  'утро': 'morning',
  'утренний': 'morning',
  'вечер': 'evening',
  'вечерний': 'evening',
  'небо': 'sky',
  'облака': 'clouds',
  'тучи': 'clouds',
  'дождь': 'rain',
  'дождливый': 'rain',
  'снег': 'snow',
  'снежный': 'snow',
  'шторм': 'storm',
  'буря': 'storm',
  'гроза': 'storm',
  'гром': 'thunder',
  'молния': 'thunder',
  'туман': 'fog',
  'туманный': 'fog',
  'радуга': 'rainbow',
  'солнце': 'sun',
  'луна': 'moon',
  'месяц': 'moon',
  'звезды': 'stars',
  'звезда': 'star',
  'галактика': 'galaxy',
  'космос': 'space',
  'космический': 'space',
  'море': 'sea',
  'морской': 'sea',
  'океан': 'ocean',
  'пляж': 'beach',
  'берег': 'beach',
  'река': 'river',
  'речка': 'river',
  'озеро': 'lake',
  'водопад': 'waterfall',
  'гора': 'mountain',
  'горы': 'mountain',
  'горный': 'mountain',
  'лес': 'forest',
  'леса': 'forest',
  'лесной': 'forest',
  'дерево': 'tree',
  'цветок': 'flower',
  'цветы': 'flowers',
  'роза': 'rose',
  'сакура': 'sakura',
  'вишневый цвет': 'cherry_blossoms',
  'трава': 'grass',
  'поле': 'field',
  'луг': 'field',
  'сад': 'garden',
  'огород': 'garden',
  'парк': 'park',
  'город': 'city',
  'поселок': 'town',
  'деревня': 'village',
  'село': 'village',
  'улица': 'street',
  'дорога': 'road',
  'мост': 'bridge',
  'здание': 'building',
  'дом': 'house',
  'домик': 'house',
  'комната': 'room',
  'спальня': 'bedroom',
  'кухня': 'kitchen',
  'ванная': 'bathroom',
  'школа': 'school',
  'класс': 'classroom',
  'библиотека': 'library',
  'магазин': 'shop',
  'кафе': 'cafe',
  'ресторан': 'restaurant',
  'бар': 'bar',
  'церковь': 'church',
  'храм': 'temple',
  'замок': 'castle',
  'руины': 'ruins',
  'развалины': 'ruins',
  'внутри': 'indoors',
  'снаружи': 'outdoors',
  'огонь': 'fire',
  'пожар': 'fire',
  'пламя': 'fire',
  'свеча': 'candle',
  'свечи': 'candle',
  'вода': 'water',
  'лед': 'ice',
  'дым': 'smoke',
  'свет': 'light',
  'светлый': 'light',
  'темнота': 'dark',
  'темный': 'dark',
  'тень': 'shadow',
  'тени': 'shadow',
  'окно': 'window',
  'окна': 'window',
  'дверь': 'door',
  'двери': 'door',
  'кровать': 'bed',
  'постель': 'bed',
  'стул': 'chair',
  'кресло': 'chair',
  'стол': 'table',
  'столик': 'table',
  'парта': 'desk',
  'диван': 'couch',
  'зеркало': 'mirror',
  'картина': 'painting',
  'живопись': 'painting',
  'плакат': 'poster',
  'постер': 'poster',
  'книга': 'book',
  'книжка': 'book',
  'книги': 'books',
  'письмо': 'letter',
  'бумага': 'paper',
  'ручка': 'pen',
  'карандаш': 'pencil',
  'кисть': 'brush',
  'камера': 'camera',
  'фотоаппарат': 'camera',
  'телефон': 'phone',
  'смартфон': 'phone',
  'компьютер': 'computer',
  'ноутбук': 'laptop',
  'клавиатура': 'keyboard',
  'наушники': 'headphones',
  'микрофон': 'microphone',
  'гитара': 'guitar',
  'пианино': 'piano',
  'фортепиано': 'piano',
  'скрипка': 'violin',
  'барабаны': 'drums',
  'флейта': 'flute',
  'труба': 'trumpet',
  'арфа': 'harp',
  'музыка': 'music',
  'музыкальный': 'music',
  'песня': 'song',
  'танец': 'dance',
  'танцы': 'dance',
  'танцует': 'dancing',
  'фильм': 'movie',
  'кино': 'movie',
  'аниме': 'anime',
  'манга': 'manga',
  'игра': 'game',
  'игры': 'game',
  'арт': 'art',
  'искусство': 'art',
  'рисунок': 'art',
  'портрет': 'portrait',
  'пейзаж': 'landscape',
  'природа': 'nature',
  'природный': 'nature',
  'абстракция': 'abstract',
  'абстрактный': 'abstract',
  'реализм': 'realistic',
  'реалистичный': 'realistic',
  'фотореализм': 'realistic',
  'скетч': 'sketch',
  'набросок': 'sketch',
  'акварель': 'watercolor',
  'масло': 'oil_painting',
  'масляная живопись': 'oil_painting',
  'монохромный': 'monochrome',
  'черно-белый': 'monochrome',
  'черно белый': 'monochrome',
  'цветной': 'colorful',
  'разноцветный': 'colorful',
  'красочный': 'colorful',
  'яркий': 'vibrant',
  'пастель': 'pastel',
  'пастельный': 'pastel',
  'неон': 'neon',
  'неоновый': 'neon',
  'светящийся': 'glowing',
  'свечение': 'glowing',
  'кровь': 'blood',
  'рана': 'wound',
  'раны': 'wound',
  'смерть': 'death',
  'любовь': 'love',
  'влюбленный': 'love',
  'сердце': 'heart',
  'сердечко': 'heart',
  'сердца': 'hearts',
  'поцелуй': 'kiss',
  'целуются': 'kiss',
  'объятие': 'hug',
  'обнимаются': 'hug',
  'друзья': 'friends',
  'дружба': 'friends',
  'милый': 'cute',
  'милая': 'cute',
  'мило': 'cute',
  'красивый': 'beautiful',
  'красивая': 'beautiful',
  'красота': 'beautiful',
  'сексуальный': 'sexy',
  'горячий': 'hot',
  'горячая': 'hot',
  'крутой': 'cool',
  'классный': 'cool',
  'смешной': 'funny',
  'забавный': 'funny',
  'усталый': 'tired',
  'уставший': 'tired',
  'сонный': 'sleepy',
  'голодный': 'hungry',
  'спит': 'sleeping',
  'сон': 'sleeping',
  'спящий': 'sleeping',
  'идет': 'walking',
  'ходьба': 'walking',
  'гуляет': 'walking',
  'бежит': 'running',
  'бег': 'running',
  'прыгает': 'jumping',
  'прыжок': 'jumping',
  'плавает': 'swimming',
  'плавание': 'swimming',
  'сидит': 'sitting',
  'сидя': 'sitting',
  'стоит': 'standing',
  'стоя': 'standing',
  'лежит': 'lying',
  'лежа': 'lying',
  'на коленях': 'kneeling',
  'поет': 'singing',
  'пение': 'singing',
  'ест': 'eating',
  'еда': 'food',
  'пьет': 'drinking',
  'питье': 'drinking',
  'курит': 'smoking',
  'курение': 'smoking',
  'смотрит на зрителя': 'looking_at_viewer',
  'смотрит в камеру': 'looking_at_viewer',
  'отводит взгляд': 'looking_away',
  'смотрит назад': 'looking_back',
  'держит': 'holding',
  'держит меч': 'holding_sword',
  'держит пистолет': 'holding_gun',
  'держит книгу': 'holding_book',
  'держит цветок': 'holding_flower',
  'держит кошку': 'holding_cat',
  'меч': 'sword',
  'нож': 'knife',
  'пистолет': 'gun',
  'винтовка': 'rifle',
  'ружье': 'rifle',
  'лук': 'bow',
  'стрела': 'arrow',
  'копье': 'spear',
  'щит': 'shield',
  'магия': 'magic',
  'волшебство': 'magic',
  'заклинание': 'spell',
  'ведьма': 'witch',
  'колдунья': 'witch',
  'ангел': 'angel',
  'демон': 'demon',
  'дьявол': 'demon',
  'призрак': 'ghost',
  'привидение': 'ghost',
  'вампир': 'vampire',
  'оборотень': 'werewolf',
  'зомби': 'zombie',
  'скелет': 'skeleton',
  'робот': 'robot',
  'киборг': 'cyborg',
  'инопланетянин': 'alien',
  'рыцарь': 'knight',
  'самурай': 'samurai',
  'ниндзя': 'ninja',
  'воин': 'warrior',
  'солдат': 'soldier',
  'полиция': 'police',
  'полицейский': 'police',
  'врач': 'doctor',
  'доктор': 'doctor',
  'медсестра': 'nurse',
  'учитель': 'teacher',
  'ученик': 'student',
  'студент': 'student',
  'горничная': 'maid',
  'официантка': 'waitress',
  'повар': 'chef',
  'косплей': 'cosplay',
  'эльф': 'elf',
  'орк': 'orc',
  'гном': 'dwarf',
  'фея': 'fairy',
  'гигант': 'giant',
  'богиня': 'goddess',

  // еда и напитки
  'кофе': 'coffee',
  'чай': 'tea',
  'пища': 'food',
  'торт': 'cake',
  'пирожное': 'cake',
  'пицца': 'pizza',
  'суши': 'sushi',
  'хлеб': 'bread',
  'фрукты': 'fruit',
  'фрукт': 'fruit',
  'яблоко': 'apple',
  'апельсин': 'orange',
  'банан': 'banana',
  'клубника': 'strawberry',
  'арбуз': 'watermelon',
  'мороженое': 'ice_cream',
  'шоколад': 'chocolate',
  'конфета': 'candy',
  'конфеты': 'candy',
  'вино': 'wine',
  'пиво': 'beer',
  'сок': 'juice',
  'молоко': 'milk',

  // транспорт и места
  'машина': 'car',
  'автомобиль': 'car',
  'велосипед': 'bicycle',
  'мотоцикл': 'motorcycle',
  'поезд': 'train',
  'автобус': 'bus',
  'самолет': 'airplane',
  'корабль': 'ship',
  'лодка': 'boat',
  'ракета': 'rocket',
  'метро': 'subway',
  'такси': 'taxi',
  'грузовик': 'truck',
  'скорая помощь': 'ambulance',
  'полицейская машина': 'police_car',
  'пожарная машина': 'fire_truck',

  // цвета
  'красный': 'red',
  'красная': 'red',
  'красное': 'red',
  'синий': 'blue',
  'синяя': 'blue',
  'голубой': 'blue',
  'зеленый': 'green',
  'зеленая': 'green',
  'желтый': 'yellow',
  'желтая': 'yellow',
  'фиолетовый': 'purple',
  'фиолетовая': 'purple',
  'розовый': 'pink',
  'розовая': 'pink',
  'оранжевый': 'orange',
  'оранжевая': 'orange',
  'коричневый': 'brown',
  'коричневая': 'brown',
  'черный': 'black',
  'черная': 'black',
  'белый': 'white',
  'белая': 'white',
  'серый': 'grey',
  'серая': 'grey',
  'золотой': 'gold',
  'золотая': 'gold',
  'серебряный': 'silver',
  'серебристый': 'silver',

  // времена года и праздники
  'зима': 'winter',
  'зимний': 'winter',
  'лето': 'summer',
  'летний': 'summer',
  'осень': 'autumn',
  'осенний': 'autumn',
  'весна': 'spring',
  'весенний': 'spring',
  'рождество': 'christmas',
  'рождественский': 'christmas',
  'новый год': 'new_year',
  'новогодний': 'new_year',
  'хэллоуин': 'halloween',
  'хеллоуин': 'halloween',
  'день рождения': 'birthday',
  'свадьба': 'wedding',
  'свадебный': 'wedding',
  'валентин': 'valentine',
  'день святого валентина': 'valentine',
};

// Ключи, которые матчатся ТОЛЬКО точной формой слова: их стем совпадает со
// стемом другого ключа с другим тегом (девушка/девушки, леди/лед, книга/книги,
// звезда/звезды, сердце/сердца). Без этого «девушка» давала multiple_girls,
// а «лед» — 1girl.
const EXACT_ONLY = new Set(['девушки', 'леди', 'звезды', 'книги', 'сердца']);

// Предсчитанные ключи: стемы слов ключа, длина ключа (для порядка обхода).
// Сортируем по числу слов, затем по длине — длинные фразы матчатся первыми.
const LEX_KEYS = Object.keys(LEX)
  // Ключ нормализуем как запрос (ё→е): иначе ключи с «ё» («котёнок», «лисёнок»)
  // никогда не матчились — запрос приходит уже в нормализованной форме.
  .map((k) => ({ key: k, stems: normalizeRu(k).split(' ').map(stemRu), len: k.length, exact: EXACT_ONLY.has(k) }))
  .sort((a, b) => b.len - a.len);

// Ищем совпадения в лексиконе. Возвращает массив английских тегов без дублей.
// Многословные ключи матчатся как непрерывная подпоследовательность стемов,
// однословные — как присутствие стема в множестве стемов запроса.
// Пунктуация по краям слов отбрасывается: без этого «дождём!» не даёт стем «дожд».
function lexicalTags(q) {
  const out = [];
  const seen = new Set();
  const words = q.split(' ').map((w) => w.replace(/[^а-яa-z0-9-]/g, '')).filter(Boolean);
  const stems = words.map(stemRu);
  const stemSet = new Set(stems);
  const wordSet = new Set(words);

  // Точная форма слова приоритетнее стемовой: «леди» не должна дополнительно
  // тянуть 'лед' (ice), а «девушки» — одновременно 1girl и multiple_girls.
  const exactStems = new Set();
  for (const item of LEX_KEYS) {
    if (item.exact && wordSet.has(item.key)) exactStems.add(item.stems[0]);
  }

  const add = (val) => {
    const arr = Array.isArray(val) ? val : [val];
    for (const t of arr) {
      if (t && !seen.has(t)) { seen.add(t); out.push(t); }
    }
  };

  for (const item of LEX_KEYS) {
    const parts = item.stems;
    let hit = false;
    if (parts.length === 1) {
      hit = item.exact
        ? wordSet.has(item.key)
        : (stemSet.has(parts[0]) && !exactStems.has(parts[0]));
    } else {
      // скользящее окно по стемам запроса
      outer: for (let i = 0; i + parts.length <= stems.length; i++) {
        for (let j = 0; j < parts.length; j++) {
          if (stems[i + j] !== parts[j]) continue outer;
        }
        hit = true;
        break;
      }
    }
    if (hit) add(LEX[item.key]);
  }
  return out;
}

// ─── Кэш ─────────────────────────────────────────────────────────────────────

// Читаем свежую запись (TTL 30 с). Храним слои {core, semantic}; старый формат
// (голый JSON-массив тегов) читается как core=всё, semantic=[]. При любой ошибке
// БД — null.
async function cacheGet(q) {
  try {
    const row = await db.get(
      'SELECT tags, src, at FROM ru_qcache WHERE q = :q',
      { ':q': q },
    );
    if (row && Number(row.at) + CACHE_TTL_MS > Date.now()) {
      try {
        const parsed = JSON.parse(row.tags || '[]');
        const layers = Array.isArray(parsed)
          ? { core: parsed, semantic: [] }
          : { core: parsed.core ?? [], semantic: parsed.semantic ?? [] };
        if (Array.isArray(layers.core) && Array.isArray(layers.semantic)) return layers;
      } catch (e) { /* битая запись — идём пересчитывать */ }
    }
  } catch (e) {
    // кэш — не критичен, молча идём дальше
  }
  return null;
}

// Пишем результат. Ошибку записи глотаем — выдача важнее кэша.
async function cachePut(q, tags, src) {
  try {
    await db.run(
      'INSERT OR REPLACE INTO ru_qcache (q, tags, src, at) VALUES (:q, :t, :s, :at)',
      { ':q': q, ':t': JSON.stringify(tags), ':s': src, ':at': Date.now() },
    );
  } catch (e) {
    // ignore
  }
}

// ─── Семантический слой ──────────────────────────────────────────────────────

// embedQuery() → косинус по top-K tag_vec → теги выше порога.
// Возвращает [] при любой ошибке (нет ключа, пустая таблица, лимит rows_read).
async function semanticTags(q) {
  try {
    const qv = await embedQuery(q);
    if (!qv) return [];
    const rows = await db.all(
      `SELECT tag, v FROM tag_vec ORDER BY n DESC LIMIT ${VEC_TOP_K}`,
    );
    if (!rows || !rows.length) return [];
    const best = { c: -1 };
    for (const r of rows) {
      const c = cosineInt8(qv, r.v);
      if (c > best.c) best.c = c;
    }
    const floor = Math.max(SIM_THRESHOLD, best.c - REL_DELTA);
    const scored = [];
    for (const r of rows) {
      const c = cosineInt8(qv, r.v);
      if (c >= floor && !isAdultTag(r.tag)) scored.push({ tag: r.tag, c });
    }
    scored.sort((a, b) => b.c - a.c);
    return scored.slice(0, EMBED_TOP_N).map((x) => x.tag);
  } catch (e) {
    console.error('ru.semanticTags failed', e && e.message);
    return [];
  }
}

// Слияние слоёв без дублей (core первым, semantic дозаполняет).
function mergeLayers(core, semantic) {
  const merged = [];
  const seen = new Set();
  for (const t of core.concat(semantic)) {
    if (t && !seen.has(t)) { seen.add(t); merged.push(t); }
  }
  return merged;
}

// ─── Главный вход ────────────────────────────────────────────────────────────

// Русский запрос → английские боору-теги.
// Возвращает { tags, src: 'cache'|'lexical'|'embed', core, semantic }:
//   core     — точный лексический перевод (ядро выдачи, И-слоты);
//   semantic — соседи по эмбед-вектору вне ядра (хвост выдачи, ИЛИ-слот).
// tags — core+semantic слитно (совместимость со старыми читателями).
// Никогда не бросает исключение.
//
// opts.allowModel=false — запретить вызов эмбеддинг-модели (хендлер зовёт так,
// пока пользователь ещё печатает: TG шлёт inline_query на каждое нажатие, и
// отправлять их все в модель нельзя). В этом режиме работают только кэш и
// лексический словарь — они бесплатные и мгновенные. Такой результат НЕ кэшируется:
// промежуточный префикс («ли» от «лиса») не должен вытеснить полный запрос.
export async function ruToTags(text, opts = {}) {
  const allowModel = opts.allowModel !== false;
  const q = normalizeRu(text);
  if (!q) return { tags: [], src: 'lexical', core: [], semantic: [] };

  // 1) кэш (слои)
  const layers = await cacheGet(q);
  if (layers) {
    return { tags: mergeLayers(layers.core, layers.semantic), src: 'cache', ...layers };
  }

  // 2) лексика — ядро
  const lex = lexicalTags(q);
  if (lex.length >= LEX_MIN_TAGS) {
    await cachePut(q, { core: lex, semantic: [] }, 'lexical');
    return { tags: [...lex], src: 'lexical', core: lex, semantic: [] };
  }

  // 3) семантика (только если лексика дала мало и модель разрешена)
  if (!allowModel) return { tags: [...lex], src: 'lexical', core: lex, semantic: [] };
  const sem = await semanticTags(q);
  const semantic = sem.filter((t) => !lex.includes(t));
  const tags = mergeLayers(lex, semantic);
  const src = sem.length ? 'embed' : 'lexical';
  await cachePut(q, { core: lex, semantic }, src);
  return { tags, src, core: lex, semantic };
}

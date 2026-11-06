// Иконки предметов в ответах: бот хранит их как эмодзи приложения Discord (до 2000 штук, видны только боту)
// и подставляет перед названием предмета. Иконки заливаются по мере надобности, по одной —
// картинки не рисуем и в памяти не держим, так что памяти почти не тратится.
import { PNG } from 'pngjs';
import { allItems } from './opendota.js';

const CDN = 'https://cdn.cloudflare.steamstatic.com';
const MAX_NEW_PER_REPLY = 30; // сколько иконок можно загрузить за один ответ
const FETCH_TIMEOUT_MS = 15_000;
const MIN_NAME_LENGTH = 4; // слишком короткие названия слишком легко совпадают с обычными словами

let manager = null; // client.application.emojis; null — эмодзи отключены
const known = new Map(); // имя эмодзи → '<:имя:id>'
const failed = new Set(); // предметы, иконку которых не удалось загрузить (до перезапуска не повторяем)
let matcher = null;

const formatEmoji = (emoji) => `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`;
const emojiName = (key) => `d2_${key}`.slice(0, 32); // у Discord имя эмодзи — до 32 символов
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Подтягивает уже загруженные эмодзи приложения. Если не вышло, иконок просто не будет. */
export async function initItemEmojis(client) {
  try {
    const all = await client.application.emojis.fetch();
    manager = client.application.emojis;
    for (const emoji of all.values()) known.set(emoji.name, formatEmoji(emoji));
    console.log(`Эмодзи предметов включены, уже загружено: ${known.size}`);
  } catch (err) {
    manager = null;
    console.warn('Эмодзи предметов отключены:', err.message);
  }
}

// Одно регулярное выражение по названиям всех предметов, длинные названия первыми
function getMatcher() {
  if (matcher) return matcher;
  const items = allItems().filter(
    (i) => i.img && i.name.length >= MIN_NAME_LENGTH && !i.key.startsWith('recipe') && !/recipe/i.test(i.name),
  );
  const byName = new Map(items.map((i) => [i.name.toLowerCase(), i]));
  const names = [...byName.keys()].sort((a, b) => b.length - a.length).map(escapeRegex);
  const regex = names.length ? new RegExp(`(?<![\\p{L}\\p{N}])(${names.join('|')})(?![\\p{L}\\p{N}])`, 'giu') : null;
  matcher = { byName, regex };
  return matcher;
}

// Иконки предметов не квадратные; докладываем прозрачные поля, чтобы Discord не исказил картинку
export function squarePng(buffer) {
  try {
    const src = PNG.sync.read(buffer);
    const size = Math.max(src.width, src.height);
    if (src.width === src.height) return buffer;
    const dst = new PNG({ width: size, height: size }); // по умолчанию прозрачный
    PNG.bitblt(src, dst, 0, 0, src.width, src.height, Math.floor((size - src.width) / 2), Math.floor((size - src.height) / 2));
    return PNG.sync.write(dst);
  } catch {
    return buffer; // не PNG или битый файл — загружаем как есть
  }
}

async function uploadIcon(item, name) {
  try {
    const res = await fetch(CDN + item.img, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`CDN ответил ${res.status}`);
    const image = squarePng(Buffer.from(await res.arrayBuffer()));
    const emoji = await manager.create({ attachment: image, name });
    const token = formatEmoji(emoji);
    known.set(name, token);
    return token;
  } catch (err) {
    failed.add(item.key);
    console.warn(`Иконка ${item.name} не загрузилась:`, err.message);
    return null;
  }
}

/** Вставляет иконку перед каждым названием предмета в тексте. Если эмодзи недоступны, возвращает текст как есть. */
export async function addItemEmojis(text) {
  if (!manager) return text;
  const { byName, regex } = getMatcher();
  if (!regex) return text;

  const mentioned = new Map();
  for (const match of text.matchAll(regex)) {
    const item = byName.get(match[1].toLowerCase());
    if (item) mentioned.set(item.key, item);
  }

  const tokens = new Map(); // название предмета в нижнем регистре → эмодзи
  let uploaded = 0;
  for (const item of mentioned.values()) {
    const name = emojiName(item.key);
    let token = known.get(name);
    if (!token && uploaded < MAX_NEW_PER_REPLY && !failed.has(item.key)) {
      uploaded++;
      token = await uploadIcon(item, name); // строго по одной: так мало памяти и нет всплеска запросов
    }
    if (token) tokens.set(item.name.toLowerCase(), token);
  }
  if (!tokens.size) return text;

  return text.replace(regex, (found) => {
    const token = tokens.get(found.toLowerCase());
    return token ? `${token} ${found}` : found;
  });
}

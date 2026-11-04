// Запросы к OpenDota API и справочники героев/предметов
import { config } from './config.js';

const BASE_URL = 'https://api.opendota.com/api';
const PARSE_WAIT_MS = 4 * 60_000;
const PARSE_POLL_MS = 20_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(path, method = 'GET') {
  const url = new URL(BASE_URL + path);
  if (config.opendotaKey) url.searchParams.set('api_key', config.opendotaKey);

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { method, signal: AbortSignal.timeout(20_000) });
      if (res.ok) return await res.json();

      lastError = new Error(`OpenDota ${res.status} на ${path}`);
      // 429 и 5xx — временные, пробуем ещё раз; остальные ошибки — сразу наверх
      if (res.status !== 429 && res.status < 500) throw lastError;
    } catch (err) {
      lastError = err;
    }
    if (attempt < 3) await sleep(3000 * attempt);
  }
  throw lastError;
}

/** Последний матч игрока (краткая запись) или null. */
export async function getLatestMatch(accountId) {
  const [latest] = await request(`/players/${accountId}/matches?limit=1`);
  return latest ?? null;
}

/** Последние ~20 матчей игрока (краткие записи, новые первыми). */
export const getRecentMatches = (accountId) => request(`/players/${accountId}/recentMatches`);

export const getMatch = (matchId) => request(`/matches/${matchId}`);

const isParsed = (match) => match?.version != null;

/**
 * Детали матча, по возможности с разобранным реплеем — только в нём есть
 * график золота, драки, объекты и чат. Если реплей не разобран, заказывает
 * разбор и ждёт до 4 минут; не дождался — возвращает то, что есть.
 */
export async function getParsedMatch(matchId) {
  const match = await getMatch(matchId);
  if (isParsed(match) || !match?.players?.length) return match;

  try {
    await request(`/request/${matchId}`, 'POST');
  } catch (err) {
    console.warn(`Не удалось заказать разбор матча ${matchId}:`, err.message);
    return match;
  }

  console.log(`Матч ${matchId} ещё не разобран, жду OpenDota…`);
  const deadline = Date.now() + PARSE_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(PARSE_POLL_MS);
    const fresh = await getMatch(matchId).catch(() => null);
    if (isParsed(fresh)) return fresh;
  }

  console.warn(`Матч ${matchId} так и не разобрался, комментирую по краткой статистике`);
  return match;
}

// --- Справочники: id героя/предмета → название. Грузятся один раз при старте ---

const heroesById = {};
const heroInfoById = {}; // id → { id, name, attr, attack, roles }
const heroList = []; // все герои: { id, name, norm }
const heroesByNpc = {}; // 'npc_dota_hero_pudge' → 'Pudge'
const itemsById = {};
const itemsByKey = {}; // 'blink' → { name: 'Blink Dagger', cost: 2250 }

export async function loadConstants() {
  const [heroes, itemIds, items] = await Promise.all([
    request('/constants/heroes'),
    request('/constants/item_ids'),
    request('/constants/items'),
  ]);

  for (const [id, hero] of Object.entries(heroes)) {
    heroesById[id] = hero.localized_name;
    heroInfoById[id] = {
      id: Number(id),
      name: hero.localized_name,
      attr: hero.primary_attr,
      attack: hero.attack_type,
      roles: hero.roles || [],
    };
    heroList.push({ id: Number(id), name: hero.localized_name, norm: normalizeName(hero.localized_name) });
    heroesByNpc[hero.name] = hero.localized_name;
  }
  for (const [key, item] of Object.entries(items)) {
    itemsByKey[key] = { name: item.dname || key, cost: item.cost || 0, img: item.img || null };
  }
  for (const [id, key] of Object.entries(itemIds)) {
    itemsById[id] = itemsByKey[key]?.name || key;
  }
}

export const heroName = (id) => heroesById[id] || `герой #${id}`;
export const heroByNpc = (npc) => heroesByNpc[npc] || null;
export const itemName = (id) => (id ? itemsById[id] || null : null);
export const itemByKey = (key) => itemsByKey[key] || null;
export const allItems = () => Object.entries(itemsByKey).map(([key, item]) => ({ key, ...item }));

// 'Anti-Mage' → 'antimage': для поиска героя по введённому тексту
export const normalizeName = (text) => String(text).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
export const allHeroes = () => heroList;
export const heroInfo = (id) => heroInfoById[id] || null;

// Популярные предметы героя по этапам игры; кэш на 6 часов, чтобы не дёргать API лишний раз
const POPULARITY_TTL_MS = 6 * 3_600_000;
const popularityCache = new Map();

export async function getItemPopularity(heroId) {
  const cached = popularityCache.get(heroId);
  if (cached && Date.now() - cached.at < POPULARITY_TTL_MS) return cached.data;
  const data = await request(`/heroes/${heroId}/itemPopularity`);
  popularityCache.set(heroId, { at: Date.now(), data });
  return data;
}

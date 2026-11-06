// Команда /test-live: проверяет, видит ли OpenDota и STRATZ идущий матч наших игроков и пики в нём.
// Запускай во время игры (лучше на стадии выбора героев). Ничего не пишет в state и не шутит.
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { config } from './config.js';
import { heroName } from './opendota.js';

const OPENDOTA_LIVE_URL = 'https://api.opendota.com/api/live';
const STRATZ_URL = 'https://api.stratz.com/graphql';
const REQUEST_TIMEOUT_MS = 20_000;
const STEAM64_BASE = 76561197960265728n;

// Названия полей в разных API отличаются, поэтому ищем по нескольким вариантам
const ID_KEYS = ['account_id', 'accountId', 'steamAccountId', 'steam_account_id', 'steam_id', 'steamId'];
const HERO_KEYS = ['hero_id', 'heroId'];
const MATCH_KEYS = ['match_id', 'matchId', 'lobby_id', 'lobbyId', 'server_steam_id', 'serverSteamId'];

const firstDefined = (node, keys) => {
  const key = keys.find((k) => node[k] != null);
  return key ? node[key] : undefined;
};

// Steam ID бывает 32-битным (как в PLAYERS) и 64-битным; приводим к 32-битному
function toAccountId(value) {
  try {
    const n = BigInt(value);
    return Number(n > STEAM64_BASE ? n - STEAM64_BASE : n);
  } catch {
    return null;
  }
}

function collectHeroIds(node, out = new Set()) {
  if (Array.isArray(node)) node.forEach((n) => collectHeroIds(n, out));
  else if (node && typeof node === 'object') {
    const hero = firstDefined(node, HERO_KEYS);
    if (Number(hero) > 0) out.add(Number(hero));
    Object.values(node).forEach((v) => v && typeof v === 'object' && collectHeroIds(v, out));
  }
  return out;
}

/** Ищет в произвольном JSON наших игроков и героев в тех же матчах. */
export function findTracked(root, players) {
  const hits = [];
  const walk = (node, matchNode) => {
    if (Array.isArray(node)) return node.forEach((n) => walk(n, matchNode));
    if (!node || typeof node !== 'object') return;

    const here = firstDefined(node, MATCH_KEYS) != null ? node : matchNode;
    const idKey = ID_KEYS.find((k) => node[k] != null);
    if (idKey) {
      const accountId = toAccountId(node[idKey]);
      const player = players.find((p) => p.id === accountId);
      if (player) hits.push({ player, hero: Number(firstDefined(node, HERO_KEYS)) || 0, match: here });
    }
    for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value, here);
  };
  walk(root, null);
  return hits;
}

function describeHits(hits) {
  if (!hits.length) return 'наших игроков в списке нет ❌';
  const seen = new Set();
  return hits
    .filter((h) => !seen.has(h.player.id) && seen.add(h.player.id))
    .map((h) => {
      const matchId = h.match ? firstDefined(h.match, MATCH_KEYS) : '?';
      const heroes = h.match ? [...collectHeroIds(h.match)].map(heroName) : [];
      const own = h.hero ? heroName(h.hero) : 'герой ещё не выбран';
      return `✅ ${h.player.name}: ${own}, матч ${matchId}${heroes.length ? `\n   пики в матче: ${heroes.join(', ')}` : ''}`;
    })
    .join('\n');
}

// --- OpenDota ---

async function probeOpenDota(players) {
  const res = await fetch(OPENDOTA_LIVE_URL, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const games = Array.isArray(data) ? data : Object.values(data ?? {});
  const sample = games[0] && typeof games[0] === 'object' ? Object.keys(games[0]).slice(0, 12).join(', ') : '—';
  return `матчей в списке: ${games.length}; ${describeHits(findTracked(data, players))}\n   поля матча: ${sample}`;
}

// --- STRATZ: схема GraphQL заранее неизвестна, поэтому запрос собирается по introspection ---

const TYPE_REF = 'name kind ofType { name kind ofType { name kind ofType { name kind } } }';

async function stratzQuery(query) {
  const res = await fetch(STRATZ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.stratzToken}`,
      'User-Agent': 'STRATZ_API', // STRATZ отклоняет запросы без явного User-Agent
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors?.length && !json.data) throw new Error(json.errors[0].message);
  return json.data;
}

// Внутренний именованный тип: [Match!]! → Match
function innerType(type) {
  let t = type;
  while (t && !t.name) t = t.ofType;
  return t;
}

async function typeFields(typeName) {
  const data = await stratzQuery(
    `{ __type(name: "${typeName}") { fields { name args { name type { ${TYPE_REF} } } type { ${TYPE_REF} } } } }`,
  );
  return data.__type?.fields ?? [];
}

// Обязательные аргументы поля: для объектных подставляем {}, остальное пока не умеем
function requiredArgs(field) {
  const required = field.args.filter((a) => a.type.kind === 'NON_NULL');
  const parts = required.map((a) => (innerType(a.type).kind === 'INPUT_OBJECT' ? `${a.name}: {}` : null));
  if (parts.includes(null)) {
    throw new Error(`у поля ${field.name} есть обязательные аргументы: ${required.map((a) => a.name).join(', ')}`);
  }
  return parts.length ? `(${parts.join(', ')})` : '';
}

// Нужные поля по предпочтительным именам; если их мало — добираем скалярами
function pickFields(fields, preferred, max = 8) {
  const names = fields.map((f) => f.name);
  const picked = preferred.filter((n) => names.includes(n));
  for (const f of fields) {
    if (picked.length >= Math.min(3, max)) break;
    if (!picked.includes(f.name) && ['SCALAR', 'ENUM'].includes(innerType(f.type)?.kind)) picked.push(f.name);
  }
  return picked.slice(0, max);
}

async function probeStratz(players) {
  if (!config.stratzToken) return 'токен не задан (добавь STRATZ_TOKEN в .env)';

  const root = await typeFields('Query');
  const live = root.find((f) => f.name === 'live');
  if (!live) {
    const similar = root.map((f) => f.name).filter((n) => /live|match/i.test(n));
    return `в схеме нет поля live; похожие поля: ${similar.join(', ') || 'нет'}`;
  }

  const liveFields = await typeFields(innerType(live.type).name);
  const matchesField = liveFields.find((f) => f.name === 'matches') ?? liveFields.find((f) => /match/i.test(f.name));
  if (!matchesField) return `в live нет списка матчей; поля: ${liveFields.map((f) => f.name).join(', ')}`;

  const matchFields = await typeFields(innerType(matchesField.type).name);
  const matchSelection = pickFields(matchFields, ['matchId', 'lobbyId', 'gameTime', 'gameState', 'averageRank', 'isUpdating']);
  const playersField = matchFields.find((f) => f.name === 'players');
  let playerSelection = [];
  if (playersField) {
    const playerFields = await typeFields(innerType(playersField.type).name);
    playerSelection = pickFields(playerFields, ['steamAccountId', 'heroId', 'isRadiant', 'playerSlot']);
  }

  const inner = [...matchSelection, ...(playerSelection.length ? [`players { ${playerSelection.join(' ')} }`] : [])].join(' ');
  const query = `{ live${requiredArgs(live)} { ${matchesField.name}${requiredArgs(matchesField)} { ${inner} } } }`;

  let data;
  try {
    data = await stratzQuery(query);
  } catch (err) {
    throw new Error(`${err.message}\n   запрос: ${query}`); // по запросу видно, что именно не принял STRATZ
  }
  const matches = data?.live?.[matchesField.name] ?? [];
  const note = playersField ? '' : '\n   у матча нет списка игроков (players), пики не видны';
  return `матчей в списке: ${matches.length}; ${describeHits(findTracked(data, players))}${note}\n   запрос: ${query}`;
}

/** Проверяет оба источника; ошибка одного не мешает другому. */
export async function probeLive() {
  const players = config.players;
  const settle = async (name, fn) => {
    try {
      return `**${name}**: ${await fn(players)}`;
    } catch (err) {
      return `**${name}**: ошибка — ${err.message}`;
    }
  };
  const results = [await settle('OpenDota /live', probeOpenDota), await settle('STRATZ live', probeStratz)];
  return results.join('\n\n').slice(0, 1900);
}

// --- Discord ---

export const liveCommand = new SlashCommandBuilder()
  .setName('test-live')
  .setDescription('Проверить, видит ли OpenDota и STRATZ идущий матч наших игроков')
  .addBooleanOption((o) => o.setName('скрыто').setDescription('Показать ответ только мне (по умолчанию — всем в канале)'));

export async function handleLiveCommand(interaction) {
  const hidden = interaction.options.getBoolean('скрыто') ?? false;
  await interaction.deferReply(hidden ? { flags: MessageFlags.Ephemeral } : {}); // по умолчанию обычное сообщение в канале
  await interaction.editReply(await probeLive());
}

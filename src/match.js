// Сбор данных о матче: кто из наших играл, за кого, чем закончилось
import { config } from './config.js';
import { getParsedMatch, heroName, itemName } from './opendota.js';

const GAME_MODES = {
  1: 'All Pick',
  2: 'Captains Mode',
  3: 'Random Draft',
  4: 'Single Draft',
  5: 'All Random',
  12: 'Least Played',
  16: 'Captains Draft',
  18: 'Ability Draft',
  20: 'All Random Deathmatch',
  21: '1v1 Solo Mid',
  22: 'All Pick',
  23: 'Turbo',
};
const RANKED_LOBBY = 7;

export const isRadiantSlot = (slot) => slot < 128;
export const sideName = (radiant) => (radiant ? 'Radiant' : 'Dire');

export function formatDuration(totalSec) {
  const min = Math.floor(totalSec / 60);
  const sec = String(totalSec % 60).padStart(2, '0');
  return `${min}:${sec}`;
}

function modeName(gameMode, lobbyType) {
  const mode = GAME_MODES[gameMode] || `режим #${gameMode}`;
  return lobbyType === RANKED_LOBBY ? `${mode} (рейтинг)` : mode;
}

function finalItems(p) {
  return [p.item_0, p.item_1, p.item_2, p.item_3, p.item_4, p.item_5].map(itemName).filter(Boolean);
}

/**
 * Кого разбирать в матче, запрошенном вручную: наших игроков из PLAYERS,
 * а если их нет — самого богатого и того, кто больше всех умер.
 * Возвращает [{ player, entry }], где entry — строка игрока из match.players.
 */
export function pickTracked(match) {
  const ours = config.players
    .map((player) => ({ player, entry: match.players.find((p) => p.account_id === player.id) }))
    .filter((t) => t.entry);
  if (ours.length) return ours;

  const maxBy = (key) => match.players.reduce((a, b) => ((b[key] ?? -1) > (a[key] ?? -1) ? b : a));
  const picked = new Set([maxBy('net_worth'), maxBy('deaths')]);
  return [...picked].map((entry) => {
    const name = entry.personaname || `Аноним на ${heroName(entry.hero_id)}`;
    return { player: { nick: name, name, id: entry.account_id }, entry };
  });
}

/**
 * Собирает всё, что нужно для разбора матча.
 * tracked — [{ player, entry }]: игрок из PLAYERS и его краткая запись о матче.
 * match — уже загруженные детали матча (необязательно).
 */
export async function buildMatchInfo(matchId, tracked, match = null) {
  if (!match) {
    match = await getParsedMatch(matchId).catch((err) => {
      console.warn(`Нет деталей матча ${matchId}, будет только краткая статистика:`, err.message);
      return null;
    });
  }
  if (!match?.players?.length) match = null;

  const summary = match || tracked[0]?.entry;
  if (!summary) throw new Error(`Нет данных по матчу ${matchId}`);

  const ours = tracked.map(({ player, entry }) => {
    // В деталях матча ищем игрока по account_id, а если профиль скрыт — по слоту
    const details =
      match?.players.find((p) => p.account_id === player.id) ||
      match?.players.find((p) => p.player_slot === entry?.player_slot) ||
      null;
    const stats = details || entry;
    const radiant = isRadiantSlot(stats.player_slot);
    return {
      player,
      stats, // полная строка из деталей матча или краткая запись
      details, // только полная строка (null, если деталей нет)
      slot: stats.player_slot,
      radiant,
      won: radiant === summary.radiant_win,
      hero: heroName(stats.hero_id),
      items: details ? finalItems(details) : [],
    };
  });

  return {
    matchId,
    match,
    parsed: match?.version != null,
    duration: summary.duration,
    mode: modeName(summary.game_mode, summary.lobby_type),
    radiantWin: summary.radiant_win,
    score: match ? { radiant: match.radiant_score, dire: match.dire_score } : null,
    ours,
  };
}

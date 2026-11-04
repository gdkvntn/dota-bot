// Автопроверка: раз в INTERVAL_MIN смотрим последний матч каждого игрока и пишем о новых
import { config } from './config.js';
import { getLatestMatch } from './opendota.js';
import { makeReport } from './report.js';
import { backfillHistory } from './history.js';
import * as state from './state.js';

const MAX_ATTEMPTS = 3; // после стольких неудач матч пропускается
const failures = new Map(); // matchId → число неудачных попыток

export async function checkNewMatches(channel) {
  const newMatches = await findNewMatches();
  for (const [matchId, tracked] of newMatches) {
    await postMatch(channel, matchId, tracked);
  }
  state.saveState();
}

/** Возвращает Map: matchId → [{ player, entry }] — новые матчи и кто из наших в них играл. */
async function findNewMatches() {
  const found = new Map();

  for (const player of config.players) {
    const latest = await getLatestMatch(player.id).catch((err) => {
      console.warn(`Не удалось получить последний матч ${player.name}:`, err.message);
      return null;
    });
    if (!latest) continue;

    const known = state.getLastMatch(player.id);
    await backfillHistory(player, known ?? latest.match_id); // только если истории ещё нет
    if (known === null) {
      // Первый запуск: запоминаем, о старой игре не пишем
      state.setLastMatch(player.id, latest.match_id);
      console.log(`${player.name}: запомнил последний матч ${latest.match_id}`);
      continue;
    }
    if (latest.match_id <= known) continue;

    // Матч уже разобран через другого игрока из этой же игры
    if (state.isPosted(latest.match_id)) {
      state.setLastMatch(player.id, latest.match_id);
      continue;
    }

    if (!found.has(latest.match_id)) found.set(latest.match_id, []);
    found.get(latest.match_id).push({ player, entry: latest });
  }

  return found;
}

async function postMatch(channel, matchId, tracked) {
  console.log(`Новый матч ${matchId}: ${tracked.map((t) => t.player.name).join(', ')}`);

  try {
    for (const message of await makeReport(matchId, tracked, { record: true })) await channel.send(message);
  } catch (err) {
    const attempt = (failures.get(matchId) || 0) + 1;
    failures.set(matchId, attempt);
    console.error(`Ошибка с матчем ${matchId} (попытка ${attempt}/${MAX_ATTEMPTS}):`, err.message);
    if (attempt < MAX_ATTEMPTS) return; // повторим на следующей проверке
    console.error(`Матч ${matchId} пропущен`);
  }

  failures.delete(matchId);
  state.markPosted(matchId);
  for (const { player } of tracked) state.setLastMatch(player.id, matchId);
}

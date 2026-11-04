// Память бота между перезапусками: data/state.json
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const MAX_POSTED = 500;
const MAX_RECENT_JOKES = 10;

let state = {
  lastMatch: {}, // accountId → id последнего матча игрока, который бот уже видел
  posted: [], // матчи, о которых уже написали (если в матче двое наших — пост один)
  lastJokeAt: null, // когда была последняя шутка по расписанию (мс)
  recentJokes: [], // последние шутки — чтобы модель не повторялась
  history: {}, // accountId → [{ matchId, hero, win, kills, deaths, assists, ... }] — все матчи, без ограничений
};

export function loadState() {
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(config.stateFile, 'utf8')) };
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('Не удалось прочитать state, начинаю с нуля:', err.message);
  }
}

export function saveState() {
  fs.mkdirSync(path.dirname(config.stateFile), { recursive: true });
  // Пишем во временный файл и переименовываем — так файл не побьётся при падении
  const tmp = `${config.stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, config.stateFile);
}

export const getLastMatch = (accountId) => state.lastMatch[accountId] ?? null;

export function setLastMatch(accountId, matchId) {
  state.lastMatch[accountId] = matchId;
}

export const isPosted = (matchId) => state.posted.includes(matchId);

export function markPosted(matchId) {
  if (isPosted(matchId)) return;
  state.posted = [...state.posted, matchId].slice(-MAX_POSTED);
}

export const getLastJokeAt = () => state.lastJokeAt;
export const getRecentJokes = () => state.recentJokes;

export function addJoke(text) {
  state.lastJokeAt = Date.now();
  state.recentJokes = [...state.recentJokes, text].slice(-MAX_RECENT_JOKES);
}

export const getHistory = (accountId) => state.history[accountId] ?? [];

/** Добавляет матч в историю игрока. Повторно один и тот же матч не пишется. */
export function addHistory(accountId, entry) {
  const list = (state.history[accountId] ??= []);
  if (list.some((m) => m.matchId === entry.matchId)) return;
  list.push(entry);
  list.sort((a, b) => a.matchId - b.matchId); // всегда от старых к новым
}

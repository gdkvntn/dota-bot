// Шутка про случайного игрока из PLAYERS раз в JOKE_INTERVAL_HOURS часов
import { config } from './config.js';
import { generateJoke } from './llm.js';
import { resolveStyle } from './styles.js';
import * as state from './state.js';

const pickRandom = (list) => list[Math.floor(Math.random() * list.length)];

let lastTarget = null;

// Случайный игрок, по возможности не тот же, что в прошлый раз
function pickTarget() {
  const names = config.players.map((p) => p.name);
  const candidates = names.length > 1 ? names.filter((name) => name !== lastTarget) : names;
  lastTarget = pickRandom(candidates);
  return lastTarget;
}

export async function postJoke(channel) {
  const target = pickTarget();
  const style = resolveStyle('random');
  const { text, model } = await generateJoke(target, style.text, state.getRecentJokes());

  // allowedMentions: модель не сможет случайно пингнуть @everyone
  await channel.send({ content: text, allowedMentions: { parse: [] } });
  state.addJoke(text);
  state.saveState();
  console.log(`Шутка про ${target} (${style.key}, ${model})`);
}

/**
 * Запускает шутки по расписанию. Время последней шутки хранится в state,
 * поэтому перезапуск бота не сбивает интервал. Самая первая шутка — сразу.
 */
export function scheduleJokes(channel) {
  if (!config.jokeIntervalHours || !config.players.length) return;

  const intervalMs = config.jokeIntervalHours * 3_600_000;
  const sinceLast = Date.now() - (state.getLastJokeAt() ?? 0);
  const firstDelay = Math.max(0, intervalMs - sinceLast);

  const run = () => postJoke(channel).catch((err) => console.error('Не удалось пошутить:', err.message));
  setTimeout(() => {
    run();
    setInterval(run, intervalMs);
  }, firstDelay);

  console.log(`Шутки про случайного игрока каждые ${config.jokeIntervalHours} ч, следующая через ${Math.round(firstDelay / 60_000)} мин`);
}

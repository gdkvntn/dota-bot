// Готовит разбор матча: данные → текст для модели → ответ модели → сообщения для Discord
import { config } from './config.js';
import { buildMatchInfo } from './match.js';
import { describeMatch } from './describe.js';
import { generateComment } from './llm.js';
import { resolveStyle } from './styles.js';

const DISCORD_LIMIT = 2000;

/**
 * Возвращает ответ модели, нарезанный на сообщения Discord.
 * options.match — уже загруженные детали матча, options.style — стиль вместо STYLE из .env.
 */
export async function makeReport(matchId, tracked, { match = null, style = config.style } = {}) {
  const info = await buildMatchInfo(matchId, tracked, match);
  const { key, text: styleText } = resolveStyle(style);
  const { text, model } = await generateComment(describeMatch(info), styleText);

  console.log(`Матч ${matchId}: ответ от ${model}, стиль ${key}, ${text.length} симв.`);
  return splitMessage(text);
}

// Режет длинный текст на куски до 2000 символов, стараясь не рвать абзацы
function splitMessage(text) {
  const parts = [];
  let rest = text.trim();
  while (rest.length > DISCORD_LIMIT) {
    let cut = rest.lastIndexOf('\n', DISCORD_LIMIT);
    if (cut < DISCORD_LIMIT / 2) cut = rest.lastIndexOf(' ', DISCORD_LIMIT);
    if (cut <= 0) cut = DISCORD_LIMIT;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

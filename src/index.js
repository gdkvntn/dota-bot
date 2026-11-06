// Точка входа.
//   npm start                    — запустить бота
//   npm run test-match -- <id>   — разобрать матч в консоли, без Discord
//   npm run test-joke            — шутка про случайного игрока в консоли, без Discord
//   npm run test-live            — проверить live-матч через OpenDota и STRATZ (запускать во время игры)
//   npm run test-build -- "Антон=Invoker, Pudge" "Axe, Lion" — сборка под драфт в консоли
import { config, requireConfig } from "./config.js";
import { getParsedMatch, loadConstants } from "./opendota.js";
import { buildMatchInfo, pickTracked } from "./match.js";
import { describeMatch } from "./describe.js";
import { generateComment, generateJoke } from "./llm.js";
import { resolveStyle } from "./styles.js";
import { runBot } from "./bot.js";
import { parseTeam, makeBuild } from "./build.js";
import { loadState } from "./state.js";
import { probeLive } from "./live.js";

async function testMatch(matchId) {
  if (!Number.isInteger(matchId))
    throw new Error("Использование: npm run test-match -- <match_id>");
  requireConfig("openrouterKey");
  loadState();
  await loadConstants();

  const match = await getParsedMatch(matchId);
  const info = await buildMatchInfo(matchId, pickTracked(match), match);
  const description = describeMatch(info, { history: true });
  console.log(`--- Данные для модели ---\n${description}\n`);

  const style = resolveStyle(config.style);
  const { text, model } = await generateComment(description, style.text);
  console.log(
    `--- Ответ (${style.key}, ${model}, ${text.length} симв.) ---\n${text}`,
  );
}

async function testJoke() {
  requireConfig("openrouterKey");
  if (!config.players.length)
    throw new Error("PLAYERS пуст — не над кем шутить");
  const target =
    config.players[Math.floor(Math.random() * config.players.length)].name;
  const style = resolveStyle("random");
  const { text, model } = await generateJoke(target, style.text, []);
  console.log(`--- Шутка про ${target} (${style.key}, ${model}) ---\n${text}`);
}

async function testBuild(oursRaw, enemiesRaw) {
  if (!oursRaw)
    throw new Error(
      'Использование: npm run test-build -- "Антон=Invoker, Pudge" "Axe, Lion"',
    );
  requireConfig("openrouterKey");
  loadState();
  await loadConstants();
  const ours = parseTeam(oursRaw, "мои", { allowNames: true });
  const enemies = parseTeam(enemiesRaw || "", "враги", { allowNames: false });
  const { text, model, description } = await makeBuild(
    ours,
    enemies,
    config.style,
  );
  console.log(`--- Данные для модели ---\n${description}\n`);
  console.log(`--- Ответ (${model}, ${text.length} симв.) ---\n${text}`);
}

async function testLive() {
  await loadConstants();
  console.log((await probeLive()).replaceAll("**", ""));
}

function pickMode() {
  if (process.argv.includes("--live")) return testLive;
  const buildArgIndex = process.argv.indexOf("--build");
  if (buildArgIndex !== -1)
    return () =>
      testBuild(process.argv[buildArgIndex + 1], process.argv[buildArgIndex + 2]);
  const matchArgIndex = process.argv.indexOf("--match");
  if (matchArgIndex !== -1)
    return () => testMatch(Number(process.argv[matchArgIndex + 1]));
  if (process.argv.includes("--joke")) return testJoke;
  return runBot;
}

const main = pickMode();

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

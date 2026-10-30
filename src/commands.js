// Слэш-команда /match id:<число или ссылка> [style:<стиль>]
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { config } from './config.js';
import { getParsedMatch } from './opendota.js';
import { pickTracked } from './match.js';
import { makeReport } from './report.js';
import { STYLES } from './styles.js';

const styleChoices = ['random', ...Object.keys(STYLES)].map((key) => ({ name: key, value: key }));

export const matchCommand = new SlashCommandBuilder()
  .setName('match')
  .setDescription('Разобрать матч Dota 2')
  .addStringOption((o) => o.setName('id').setDescription('ID матча или ссылка на Dotabuff/OpenDota').setRequired(true))
  .addStringOption((o) =>
    o
      .setName('style')
      .setDescription('Стиль комментария (по умолчанию — из настроек)')
      .addChoices(...styleChoices),
  );

// '9066099884' или 'https://www.dotabuff.com/matches/9066099884' → 9066099884
function parseMatchId(raw) {
  const numbers = raw.match(/\d{6,}/g);
  return numbers ? Number(numbers.at(-1)) : null;
}

export async function handleMatchCommand(interaction) {
  const matchId = parseMatchId(interaction.options.getString('id', true));
  if (!matchId) {
    await interaction.reply({
      content: 'Это не похоже на ID матча. Пример: `/match id:9066099884`',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Разбор займёт дольше 3 секунд — показываем «бот думает…»
  await interaction.deferReply();
  console.log(`/match ${matchId} от ${interaction.user.tag}`);

  const match = await getParsedMatch(matchId).catch(() => null);
  if (!match?.players?.length) {
    await interaction.editReply(`Матч \`${matchId}\` не нашёл в OpenDota 🤷`);
    return;
  }

  const style = interaction.options.getString('style') || config.style;
  const [first, ...rest] = await makeReport(matchId, pickTracked(match), { match, style });
  await interaction.editReply(first);
  for (const message of rest) await interaction.followUp(message);
}

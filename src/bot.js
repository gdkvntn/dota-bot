// Discord-клиент: вход, регистрация команд, запуск автопроверки по таймеру
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { config, requireConfig } from './config.js';
import { loadConstants } from './opendota.js';
import { loadState } from './state.js';
import { checkNewMatches } from './watcher.js';
import { scheduleJokes } from './jokes.js';
import { handleMatchCommand, matchCommand } from './commands.js';

export async function runBot() {
  requireConfig('discordToken', 'channelId', 'openrouterKey');
  if (!config.players.length) throw new Error('PLAYERS пуст — некого отслеживать');

  loadState();
  await loadConstants();

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.once(Events.ClientReady, onReady);
  client.on(Events.GuildCreate, registerCommands);
  client.on(Events.InteractionCreate, onInteraction);
  await client.login(config.discordToken);
}

async function onReady(client) {
  console.log(`Вошёл как ${client.user.tag}`);
  console.log(`Слежу за: ${config.players.map((p) => `${p.name} (${p.id})`).join(', ')}`);
  console.log(`Проверка каждые ${config.intervalMin} мин, модели: ${config.models.join(', ')}`);

  for (const guild of client.guilds.cache.values()) await registerCommands(guild);

  const channel = await client.channels.fetch(config.channelId);
  if (!channel?.isTextBased()) throw new Error(`Канал ${config.channelId} не найден или не текстовый`);

  startSchedule(() => checkNewMatches(channel));
  scheduleJokes(channel);
}

// Запускает задачу сразу и затем раз в INTERVAL_MIN; новая проверка не стартует, пока идёт предыдущая
function startSchedule(task) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await task();
    } catch (err) {
      console.error('Ошибка проверки:', err);
    } finally {
      running = false;
    }
  };
  tick();
  setInterval(tick, config.intervalMin * 60_000);
}

// Команды регистрируются на каждом сервере: так они появляются сразу, а не через час, как глобальные
async function registerCommands(guild) {
  try {
    await guild.commands.set([matchCommand.toJSON()]);
    console.log(`Команды зарегистрированы на сервере «${guild.name}»`);
  } catch (err) {
    console.error(`Не удалось зарегистрировать команды на сервере «${guild.name}»:`, err.message);
  }
}

async function onInteraction(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== matchCommand.name) return;
  try {
    await handleMatchCommand(interaction);
  } catch (err) {
    console.error('Ошибка команды /match:', err);
    const reply = { content: 'Что-то сломалось, попробуй ещё раз позже 🤕' };
    await (interaction.deferred ? interaction.editReply(reply) : interaction.reply(reply)).catch(() => {});
  }
}

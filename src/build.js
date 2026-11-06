// Команда /сборка: пользователь вводит героев своей команды и врагов,
// бот подтягивает популярные предметы героев и просит модель накидать сборку под драфт.
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { config } from './config.js';
import { allHeroes, allItems, getItemPopularity, heroInfo, itemByKey, itemName, normalizeName } from './opendota.js';
import { addItemEmojis } from './emojis.js';
import { generateBuild } from './llm.js';
import { splitMessage } from './report.js';
import { resolveStyle, STYLES } from './styles.js';
import * as state from './state.js';

const MAX_TEAM = 5;
const MAX_CHOICES = 25; // лимит Discord на подсказки автодополнения

// Сокращения героев, которые игроки реально пишут. Ключи — в нижнем регистре, без пробелов и знаков.
// Значение — название героя (как в игре). Пополняйте под свою компанию.
const ALIASES = {
  wk: 'Wraith King', sf: 'Shadow Fiend', am: 'Anti-Mage', pa: 'Phantom Assassin', tb: 'Terrorblade',
  qop: 'Queen of Pain', np: "Nature's Prophet", ck: 'Chaos Knight', lc: 'Legion Commander',
  ss: 'Shadow Shaman', ww: 'Winter Wyvern', void: 'Faceless Void', nec: 'Necrophos', necr: 'Necrophos',
  bs: 'Bloodseeker', es: 'Earthshaker', dk: 'Dragon Knight', ta: 'Templar Assassin', bh: 'Bounty Hunter',
  naix: 'Lifestealer', dp: 'Death Prophet', инвокер: 'Invoker', инво: 'Invoker', пудж: 'Pudge',
  некр: 'Necrophos', некрофос: 'Necrophos', акс: 'Axe', лион: 'Lion', джагг: 'Juggernaut',
  джаггернаут: 'Juggernaut', свен: 'Sven', рики: 'Riki', антимаг: 'Anti-Mage',
};

/** Ошибка, текст которой безопасно показать пользователю. */
export class UserError extends Error {}

const levenshtein = (a, b) => {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
};

/** Находит героя по введённому тексту: { hero } или { error }. */
export function resolveHero(query) {
  const heroes = allHeroes();
  let q = normalizeName(query);
  if (!q) return { error: 'Пустое название героя.' };
  if (ALIASES[q]) q = normalizeName(ALIASES[q]);

  const exact = heroes.find((h) => h.norm === q);
  if (exact) return { hero: exact };

  const starts = heroes.filter((h) => h.norm.startsWith(q));
  if (starts.length === 1) return { hero: starts[0] };
  if (starts.length > 1) {
    return { error: `«${query}» — это кто? Подходят: ${starts.slice(0, 5).map((h) => h.name).join(', ')}. Напиши точнее.` };
  }

  const includes = heroes.filter((h) => h.norm.includes(q));
  if (includes.length === 1) return { hero: includes[0] };

  // Опечатка: ближайший герой не дальше чем на 2 правки
  if (q.length >= 4) {
    const near = heroes
      .map((h) => ({ h, d: levenshtein(q, h.norm) }))
      .filter(({ d }) => d <= 2)
      .sort((a, b) => a.d - b.d);
    if (near.length) return { hero: near[0].h };
  }
  return { error: `Не нашёл героя «${query}». Проверь написание или используй подсказки при вводе.` };
}

/**
 * Разбирает «Антон=Invoker, Pudge, Axe» в [{ who, hero }].
 * who — имя игрока (только если allowNames), hero — { id, name }.
 */
export function parseTeam(raw, label, { allowNames }) {
  const entries = (raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (entries.length > MAX_TEAM) throw new UserError(`В поле «${label}» героев больше пяти.`);
  return entries.map((entry) => {
    const named = allowNames ? entry.match(/^([^=:]+)[=:](.+)$/) : null;
    const who = named ? named[1].trim() : null;
    const result = resolveHero(named ? named[2] : entry);
    if (result.error) throw new UserError(result.error);
    return { who, hero: result.hero };
  });
}

// --- Описание для модели ---

const PHASES = [
  ['start_game_items', 'старт', 6],
  ['early_game_items', 'ранняя игра', 8],
  ['mid_game_items', 'середина', 8],
  ['late_game_items', 'поздняя игра', 8],
];
const SKIP_ITEMS = /^(town portal scroll|recipe)/i;

// Ключ предмета из ответа OpenDota (id или внутреннее имя) → читаемое название
function itemLabel(key) {
  const label = /^\d+$/.test(key) ? itemName(key) : itemByKey(key)?.name ?? key;
  return label || null;
}

function topItems(phase, limit) {
  return Object.entries(phase || {})
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => itemLabel(key))
    .filter((label) => label && !SKIP_ITEMS.test(label))
    .slice(0, limit);
}

function findPlayer(who) {
  if (!who) return null;
  const n = normalizeName(who);
  return config.players.find((p) => normalizeName(p.name) === n || normalizeName(p.nick) === n) ?? null;
}

// «на этом герое: 5 игр, 2 победы, в среднем 8.0 смертей» — из накопленной истории
function playerHeroLine(player, heroName) {
  const games = state.getHistory(player.id).filter((m) => m.hero === heroName);
  if (!games.length) return 'в истории бота на этом герое игр нет';
  const wins = games.filter((m) => m.win).length;
  const deaths = (games.reduce((sum, m) => sum + m.deaths, 0) / games.length).toFixed(1);
  return `в истории на этом герое: ${games.length} игр, побед ${wins}, в среднем ${deaths} смертей`;
}

const traits = (heroId) => {
  const info = heroInfo(heroId);
  return [info?.attack, info?.attr, info?.roles.join('/')].filter(Boolean).join(', ');
};

async function playerBlock({ who, hero }) {
  const player = findPlayer(who);
  const label = player ? player.name : who || 'Союзник';
  const lines = [`- ${label} — ${hero.name} (${traits(hero.id)})`];
  if (player) lines.push(`  ${playerHeroLine(player, hero.name)}`);

  try {
    const popularity = await getItemPopularity(hero.id);
    for (const [key, title, limit] of PHASES) {
      const items = topItems(popularity[key], limit);
      if (items.length) lines.push(`  Популярные предметы, ${title}: ${items.join(', ')}`);
    }
  } catch (err) {
    console.warn(`Нет данных о предметах ${hero.name}:`, err.message);
    lines.push('  Данных о популярных предметах получить не удалось');
  }
  return lines;
}

// Состав команды цифрами (считает код, чтобы модель не ошибалась в счёте)
function compositionLine(team) {
  const infos = team.map((e) => heroInfo(e.hero.id));
  const count = (role) => infos.filter((i) => i?.roles.includes(role)).length;
  const attr = (a) => infos.filter((i) => i?.attr === a).length;
  return (
    `героев ${team.length}: дизейблеров ${count('Disabler')}, побегов ${count('Escape')}, нюкеров ${count('Nuker')}, ` +
    `инициаторов ${count('Initiator')}, керри ${count('Carry')}, саппортов ${count('Support')}, пушеров ${count('Pusher')}, ` +
    `ренжей ${infos.filter((i) => i?.attack === 'Ranged').length} из ${team.length}; ` +
    `атрибуты: str ${attr('str')}, agi ${attr('agi')}, int ${attr('int')}, универсалов ${attr('all')}`
  );
}

function enemyBlock(enemies) {
  if (!enemies.length) return [];
  return [
    ...enemies.map((e) => `- ${e.hero.name} (${traits(e.hero.id)})`),
    `Сводка по врагам (посчитано кодом): ${compositionLine(enemies)}`,
  ];
}

// Названия реальных предметов: модель пишет их ровно так, и бот подставляет иконки
function itemCatalog() {
  const names = allItems()
    .filter((i) => i.img && i.cost > 0 && !i.key.startsWith('recipe') && !/recipe/i.test(i.name)) // без рецептов и нейтральных (у них цена 0)
    .map((i) => i.name);
  return [...new Set(names)].sort().join(', ');
}

// Сборка нужна только тем союзникам, у которых указано имя («Антон=Invoker»).
// Если имён нет совсем, сборку получают все. Остальные союзники нужны только как контекст драфта.
export function splitAllies(ours) {
  const named = ours.filter((o) => o.who);
  return named.length ? { builds: named, context: ours.filter((o) => !o.who) } : { builds: ours, context: [] };
}

async function describeDraft(ours, enemies) {
  const { builds, context } = splitAllies(ours);
  const players = (await Promise.all(builds.map(playerBlock))).flat();
  const foes = enemyBlock(enemies);
  const contextLine = context.length
    ? ['', `Остальные союзники (только контекст драфта, сборку им НЕ давать): ${context.map((o) => o.hero.name).join(', ')}`]
    : [];

  // Оценка пика имеет смысл, только когда известны обе команды целиком
  const fullDraft = ours.length === MAX_TEAM && enemies.length === MAX_TEAM;
  const rating = fullDraft
    ? [
        '',
        'Оценка пика: НУЖНА (известны все 10 героев).',
        'Наша команда целиком:',
        ...ours.map((o) => `- ${o.hero.name} (${traits(o.hero.id)})`),
        `Сводка по нашей команде (посчитано кодом): ${compositionLine(ours)}`,
      ]
    : ['', 'Оценка пика: НЕ нужна (драфт неполный), не пиши её.'];

  return [
    'Сборку нужно дать этим игрокам:',
    ...players,
    ...contextLine,
    '',
    foes.length ? 'Враги:' : 'Враги: пока не известны (драфт идёт), сборку давай без привязки к вражескому составу.',
    ...foes,
    ...rating,
    '',
    `Допустимые названия предметов (пиши ровно так): ${itemCatalog()}`,
  ].join('\n');
}

/** Описание драфта → ответ модели. Возвращает { text, model, description }. */
export async function makeBuild(ours, enemies, styleSetting = config.style) {
  const description = await describeDraft(ours, enemies);
  const style = resolveStyle(styleSetting);
  const { text, model } = await generateBuild(description, style.text);
  console.log(`/сборка: ответ от ${model}, стиль ${style.key}, ${text.length} симв.`);
  return { text, model, description };
}

// --- Discord ---

const styleChoices = ['random', ...Object.keys(STYLES)].map((key) => ({ name: key, value: key }));

export const buildCommand = new SlashCommandBuilder()
  .setName('сборка')
  .setDescription('Накидать сборку по пикам')
  .addStringOption((o) =>
    o
      .setName('мои')
      .setDescription('Герои вашей команды через запятую. Можно с именем: Антон=Invoker, Pudge')
      .setRequired(true)
      .setAutocomplete(true),
  )
  .addStringOption((o) =>
    o.setName('враги').setDescription('Герои противников через запятую (можно неполный драфт)').setAutocomplete(true),
  )
  .addStringOption((o) =>
    o.setName('style').setDescription('Стиль комментария (по умолчанию — из настроек)').addChoices(...styleChoices),
  );

export async function handleBuildCommand(interaction) {
  let ours;
  let enemies;
  try {
    ours = parseTeam(interaction.options.getString('мои', true), 'мои', { allowNames: true });
    enemies = parseTeam(interaction.options.getString('враги') ?? '', 'враги', { allowNames: false });
    if (!ours.length) throw new UserError('Укажи хотя бы одного героя в поле «мои».');
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    await interaction.reply({ content: err.message, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply();
  console.log(`/сборка от ${interaction.user.tag}: ${ours.map((o) => o.hero.name).join(', ')} vs ${enemies.map((e) => e.hero.name).join(', ')}`);

  const style = interaction.options.getString('style') || config.style;
  const { text } = await makeBuild(ours, enemies, style);
  const [first, ...rest] = splitMessage(await addItemEmojis(text)); // иконки предметов — до нарезки на сообщения
  await interaction.editReply(first);
  for (const message of rest) await interaction.followUp(message);
}

// Подсказки героев для последнего слова в списке: «Pudge, Ax» → «Pudge, Axe»
export async function handleBuildAutocomplete(interaction) {
  const { name, value } = interaction.options.getFocused(true);
  const parts = value.split(',');
  const current = parts.pop().trimStart();
  const head = parts.length ? `${parts.map((s) => s.trim()).join(', ')}, ` : '';

  const named = name === 'мои' ? current.match(/^([^=:]+)[=:](.*)$/) : null;
  const prefix = named ? `${named[1].trim()}=` : '';
  const query = normalizeName(named ? named[2] : current);

  const choices = [];
  // Имена наших игроков: набираешь «Ан» → «Антон=»
  if (name === 'мои' && !named && query) {
    for (const p of config.players) if (normalizeName(p.name).startsWith(query)) choices.push(`${p.name}=`);
  }

  const heroes = allHeroes();
  const byAlias = Object.entries(ALIASES)
    .filter(([key]) => query && key.startsWith(query))
    .map(([, heroName]) => heroes.find((h) => h.norm === normalizeName(heroName)))
    .filter(Boolean);
  const starts = heroes.filter((h) => !query || h.norm.startsWith(query));
  const includes = heroes.filter((h) => query && !h.norm.startsWith(query) && h.norm.includes(query));
  for (const h of [...byAlias, ...starts, ...includes]) choices.push(h.name);

  const unique = [...new Set(choices)]
    .map((c) => (c.endsWith('=') ? `${head}${c}` : `${head}${prefix}${c}`))
    .filter((v) => v.length <= 100)
    .slice(0, MAX_CHOICES);
  await interaction.respond(unique.map((v) => ({ name: v, value: v })));
}

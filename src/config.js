import 'dotenv/config';

const STEAM64_OFFSET = 76561197960265728n;

function str(name, def) {
  const v = process.env[name]?.trim();
  return v ? v : def;
}

function num(name, def) {
  const raw = str(name);
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} должно быть числом, получено "${raw}"`);
  return n;
}

// Принимает 32-битный id (как в ссылке Dotabuff) или Steam64 — и приводит к 32-битному
function toAccountId(raw) {
  if (!/^\d+$/.test(raw)) throw new Error(`Некорректный id игрока "${raw}"`);
  const big = BigInt(raw);
  return Number(big >= STEAM64_OFFSET ? big - STEAM64_OFFSET : big);
}

// Формат: ник:имя:id,ник2:имя2:id2 (в нике допускается двоеточие)
function parsePlayers(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split(':').map((p) => p.trim());
      if (parts.length < 3) {
        throw new Error(`PLAYERS: ожидается "ник:имя:id", получено "${entry}"`);
      }
      const id = toAccountId(parts.pop());
      const name = parts.pop();
      const nick = parts.join(':');
      return { nick, name, id };
    });
}

export const config = {
  discordToken: str('DISCORD_TOKEN'),
  channelId: str('DISCORD_CHANNEL_ID'),
  openrouterKey: str('OPENROUTER_API_KEY'),
  models: (str('OPENROUTER_MODELS', 'google/gemini-2.5-flash') || '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean),
  style: str('STYLE', 'random'),
  maxChars: Math.min(num('MAX_CHARS', 5000), 12000),
  buildMaxChars: Math.min(num('BUILD_MAX_CHARS', 700), 2000), // длина ответа /сборка
  temperature: num('TEMPERATURE', 1.0),
  players: parsePlayers(str('PLAYERS')),
  // Имена (через запятую), над которыми бот шутит всегда
  roastTargets: (str('ROAST_TARGET', '') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  intervalMin: Math.max(num('INTERVAL_MIN', 5), 1),
  // Как часто шутить про случайного игрока из PLAYERS, в часах; 0 — не шутить
  jokeIntervalHours: Math.max(num('JOKE_INTERVAL_HOURS', 3), 0),
  opendotaKey: str('OPENDOTA_API_KEY'),
  stateFile: str('STATE_FILE', './data/state.json'),
  promptFile: str('PROMPT_FILE', './prompt.txt'),
  jokePromptFile: str('JOKE_PROMPT_FILE', './joke-prompt.txt'),
  buildPromptFile: str('BUILD_PROMPT_FILE', './build-prompt.txt'),
  stratzToken: str('STRATZ_TOKEN', ''), // нужен только для /test-live
};

export function requireConfig(...keys) {
  const envNames = {
    discordToken: 'DISCORD_TOKEN',
    channelId: 'DISCORD_CHANNEL_ID',
    openrouterKey: 'OPENROUTER_API_KEY',
  };
  const missing = keys.filter((k) => !config[k]).map((k) => envNames[k] || k);
  if (missing.length) throw new Error(`Не заданы переменные окружения: ${missing.join(', ')}`);
  if (!config.models.length) throw new Error('OPENROUTER_MODELS пуст');
}

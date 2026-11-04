// Запросы к OpenRouter. Промпты лежат в файлах (prompt.txt, joke-prompt.txt)
import fs from 'node:fs';
import { config } from './config.js';

const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const PLACEHOLDER = /\{\{(\w+)\}\}/g; // {{style}}, {{max_chars}}, {{target}} и т.п.

// Промпт читается из файла при каждом вызове — правки применяются без перезапуска
function loadPrompt(file, vars) {
  const fillLine = (line) => {
    const names = [...line.matchAll(PLACEHOLDER)].map(([, name]) => name);
    // Если какая-то подстановка пустая — строка выкидывается целиком
    if (names.some((name) => !vars[name])) return null;
    return line.replace(PLACEHOLDER, (_, name) => vars[name]);
  };

  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .map(fillLine)
    .filter((line) => line !== null)
    .join('\n')
    .trim();
}

async function callModel(model, messages) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openrouterKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/dota-bot',
      'X-Title': 'Dota 2 Discord Commentator',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: config.temperature,
      // С запасом: думающие модели тратят токены на рассуждения
      max_tokens: Math.ceil(config.maxChars * 1.5) + 4000,
    }),
    signal: AbortSignal.timeout(300_000),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    throw new Error(`${res.status} ${body.error?.message || res.statusText}`);
  }
  // Некоторые модели вставляют рассуждения прямо в текст — вырезаем их
  const text = body.choices?.[0]?.message?.content?.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!text) throw new Error('пустой ответ');
  return text;
}

/** Разбор матча по prompt.txt. Ответ модели возвращается как есть. */
export function generateComment(matchDescription, style) {
  const system = loadPrompt(config.promptFile, {
    style,
    max_chars: String(config.maxChars),
    roast_targets: config.roastTargets.join(', '),
  });
  return complete(system, `Данные матча:\n\n${matchDescription}`);
}

/** Сборка предметов под пики по build-prompt.txt. */
export function generateBuild(description, style) {
  const system = loadPrompt(config.buildPromptFile, { style, max_chars: String(config.maxChars) });
  return complete(system, `Данные драфта:\n\n${description}`);
}

/** Шутка про target по joke-prompt.txt; recentJokes — чтобы модель не повторялась. */
export function generateJoke(target, style, recentJokes) {
  const system = loadPrompt(config.jokePromptFile, {
    target,
    style,
    recent: recentJokes.map((joke) => `\n  - ${joke}`).join(''),
  });
  return complete(system, `Цель для шутки: ${target}. Пиши.`);
}

// Перебирает модели из OPENROUTER_MODELS по очереди, пока какая-нибудь не ответит
async function complete(system, user, models = config.models) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  const errors = [];
  for (const model of models) {
    try {
      const text = await callModel(model, messages);
      return { text, model };
    } catch (err) {
      console.warn(`OpenRouter: модель ${model} не ответила — ${err.message}`);
      errors.push(`${model}: ${err.message}`);
    }
  }
  throw new Error(`Ни одна модель не ответила:\n${errors.join('\n')}`);
}

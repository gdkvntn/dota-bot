// История матчей наших игроков: запись в state и сводка для модели.
// Серии («4-й раз подряд Некр») считаем здесь, в коде — модели счёт доверять нельзя.
import { getRecentMatches, heroName } from './opendota.js';
import { isRadiantSlot } from './match.js';
import * as state from './state.js';

const RECENT_LINES = 10; // сколько последних матчей показывать модели (в state пишется всё)

const resultWord = (win) => (win ? 'победа' : 'поражение');
const kdaText = (m) => `${m.kills}/${m.deaths}/${m.assists}`;

/** Записывает матч в историю каждого нашего игрока. Вызывать после успешного разбора. */
export function recordMatch(info) {
  for (const o of info.ours) {
    state.addHistory(o.player.id, {
      matchId: info.matchId,
      startTime: o.stats.start_time ?? info.match?.start_time ?? null,
      duration: info.duration,
      hero: o.hero,
      win: o.won,
      kills: o.stats.kills,
      deaths: o.stats.deaths,
      assists: o.stats.assists,
    });
  }
}

/**
 * Первичное заполнение: если истории игрока ещё нет, берём его последние матчи из OpenDota.
 * upToMatchId — не позже какого матча брать (чтобы не залезть в ещё не прокомментированные).
 */
export async function backfillHistory(player, upToMatchId) {
  if (state.getHistory(player.id).length) return;
  const recent = await getRecentMatches(player.id).catch((err) => {
    console.warn(`Не удалось загрузить историю ${player.name}:`, err.message);
    return [];
  });
  for (const m of recent) {
    if (m.match_id > upToMatchId) continue;
    state.addHistory(player.id, {
      matchId: m.match_id,
      startTime: m.start_time ?? null,
      duration: m.duration,
      hero: heroName(m.hero_id),
      win: isRadiantSlot(m.player_slot) === m.radiant_win,
      kills: m.kills,
      deaths: m.deaths,
      assists: m.assists,
    });
  }
  console.log(`${player.name}: загрузил ${state.getHistory(player.id).length} прошлых матчей в историю`);
}

// Сколько матчей в конце списка подряд удовлетворяют условию
function trailing(list, predicate) {
  let n = 0;
  for (let i = list.length - 1; i >= 0 && predicate(list[i]); i--) n++;
  return n;
}

function playerLines(o, matchId) {
  const past = state.getHistory(o.player.id).filter((m) => m.matchId < matchId);
  if (!past.length) return [];

  const lines = [];
  const recent = past.slice(-RECENT_LINES).map((m) => `${m.hero} ${m.win ? 'П' : 'Л'} ${kdaText(m)}`);
  lines.push(`- ${o.player.name}: прошлые матчи (от старых к новым): ${recent.join(', ')}`);

  // Серия на одном герое
  const sameHero = trailing(past, (m) => m.hero === o.hero);
  if (sameHero >= 1) {
    const streak = past.slice(-sameHero);
    const wins = streak.filter((m) => m.win).length;
    const avgDeaths = (streak.reduce((sum, m) => sum + m.deaths, 0) / sameHero).toFixed(1);
    lines.push(
      `  Сейчас ${o.hero} уже ${sameHero + 1}-й матч подряд; в предыдущих ${sameHero}: ${wins} побед, ${sameHero - wins} поражений, в среднем ${avgDeaths} смертей`,
    );
  } else {
    const onHero = past.filter((m) => m.hero === o.hero);
    if (!onHero.length) {
      lines.push(`  ${o.hero} — новый герой, ни разу не играл на нём за всю историю бота`);
    } else {
      const wins = onHero.filter((m) => m.win).length;
      lines.push(`  ${o.hero}: в истории ${onHero.length} матчей на нём из ${past.length}, побед ${wins}`);
    }
  }

  // Серия побед или поражений (с учётом текущего матча)
  const sameResult = trailing(past, (m) => m.win === o.won);
  if (sameResult >= 2) lines.push(`  Это ${sameResult + 1}-е ${resultWord(o.won)} подряд`);

  return lines;
}

/** Раздел «история» для описания матча. Текущий матч в историю не входит. */
export function historySection(info) {
  const lines = info.ours.flatMap((o) => playerLines(o, info.matchId));
  if (!lines.length) return [];
  return ['', 'История наших игроков до этого матча (серии уже посчитаны, не пересчитывай; П — победа, Л — поражение):', ...lines];
}

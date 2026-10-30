// Превращает данные матча в текст, который получает модель.
// Каждый раздел — отдельная функция, возвращающая массив строк (пустой, если данных нет).
import { heroByNpc, heroName, itemByKey } from './opendota.js';
import { formatDuration, isRadiantSlot, sideName } from './match.js';

const pct = (x) => `${Math.round(x * 100)}%`;
const short = (n) => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const signed = (n) => `${n > 0 ? '+' : ''}${short(n)}`;

export function describeMatch(info) {
  return [
    ...headerSection(info),
    ...trackedSection(info),
    ...teamsSection(info),
    ...goldSection(info),
    ...timelineSection(info),
    ...chatSection(info),
    ...factsSection(info),
  ].join('\n');
}

function section(title, lines) {
  return lines.length ? ['', title, ...lines] : [];
}

// Наш игрок — по имени, чужой — по герою и стороне
function labelPlayer(info, p) {
  if (!p) return 'кто-то';
  const ours = info.ours.find((o) => o.slot === p.player_slot);
  if (ours) return `${ours.player.name} (${ours.hero})`;
  return `${heroName(p.hero_id)} [${sideName(isRadiantSlot(p.player_slot))}]`;
}

// --- Заголовок ---

function headerSection(info) {
  const lines = [
    `Матч ${info.matchId}, режим: ${info.mode}, длительность ${formatDuration(info.duration)}.`,
    `Ссылка: https://www.dotabuff.com/matches/${info.matchId}`,
  ];
  if (info.score) {
    lines.push(`Счёт по убийствам: Radiant ${info.score.radiant} — Dire ${info.score.dire}. Победили ${sideName(info.radiantWin)}.`);
  }
  if (!info.parsed) {
    lines.push('(Реплей не разобран — хронологии и графика золота нет, опирайся на итоговую статистику.)');
  }
  return lines;
}

// --- Отслеживаемые игроки ---

const LANE_ROLES = { 1: 'лёгкая линия (керри)', 2: 'мид', 3: 'сложная линия (оффлейн)', 4: 'лес' };
const MULTI_KILLS = { 3: 'трипл-килл', 4: 'ультра-килл', 5: 'РАМПАГА' };

function trackedSection(info) {
  const lines = [];
  for (const o of info.ours) {
    lines.push(`- ${o.player.name} (ник ${o.player.nick}) — ${statsLine(o.stats)}; сторона ${sideName(o.radiant)}; ${o.won ? 'ПОБЕДА' : 'ПОРАЖЕНИЕ'}`);

    const contribution = contributionLine(info, o);
    if (contribution) lines.push(`  Вклад: ${contribution}`);
    if (o.items.length) lines.push(`  Итоговые предметы: ${o.items.join(', ')}`);

    if (o.details) {
      const d = o.details;
      const extra = [
        ['Детали', detailsLine(d)],
        ['По сравнению с другими игроками на этом герое', benchmarksLine(d)],
        ['Чаще всего его убивали', killersLine(d)],
        ['Тайминги предметов', timingsLine(d)],
      ];
      for (const [title, text] of extra) if (text) lines.push(`  ${title}: ${text}`);
    }
  }
  return section('Отслеживаемые игроки — подробный разбор:', lines);
}

function statsLine(p) {
  const parts = [heroName(p.hero_id), `KDA ${p.kills}/${p.deaths}/${p.assists}`];
  const optional = [
    ['ур.', p.level],
    ['добито крипов', p.last_hits],
    ['денаев', p.denies],
    ['GPM', p.gold_per_min],
    ['XPM', p.xp_per_min],
    ['net worth', p.net_worth],
    ['урон по героям', p.hero_damage],
    ['урон по башням', p.tower_damage],
    ['лечение', p.hero_healing || null],
  ];
  for (const [name, value] of optional) if (value != null) parts.push(`${name} ${value}`);
  return parts.join(', ');
}

// Доля игрока в командных показателях
function contributionLine(info, o) {
  if (!info.match) return null;
  const team = teamTotals(info.match.players, o.radiant);
  const s = o.stats;
  return [
    team.kills && `участие в убийствах команды ${pct((s.kills + s.assists) / team.kills)}`,
    team.deaths && `доля смертей команды ${pct(s.deaths / team.deaths)}`,
    team.heroDamage && s.hero_damage != null && `доля урона команды ${pct(s.hero_damage / team.heroDamage)}`,
  ]
    .filter(Boolean)
    .join(', ');
}

function detailsLine(d) {
  const parts = [];
  if (d.is_roaming) parts.push('роль: роумер');
  else if (LANE_ROLES[d.lane_role]) parts.push(`линия: ${LANE_ROLES[d.lane_role]}`);
  if (d.lane_efficiency != null) parts.push(`эффективность на линии ${pct(d.lane_efficiency)}`);
  if (d.teamfight_participation != null) parts.push(`участие в драках ${pct(d.teamfight_participation)}`);
  if (d.life_state_dead) parts.push(`провёл мёртвым ${formatDuration(d.life_state_dead)}`);
  if (d.buyback_count) parts.push(`выкупов ${d.buyback_count}`);
  if (d.obs_placed != null) parts.push(`вардов ${d.obs_placed} обс / ${d.sen_placed ?? 0} сентри`);
  if (d.stuns) parts.push(`станов ${Math.round(d.stuns)} сек`);
  if (d.camps_stacked) parts.push(`стаков ${d.camps_stacked}`);
  if (d.courier_kills) parts.push(`убил курьеров ${d.courier_kills}`);
  if (d.firstblood_claimed) parts.push('сделал первую кровь');
  if (d.actions_per_min) parts.push(`APM ${d.actions_per_min}`);

  for (const [size, count] of Object.entries(d.multi_kills || {})) {
    if (size >= 3) parts.push(`${MULTI_KILLS[size] || `${size}-килл`} ×${count}`);
  }
  return parts.join(', ');
}

// Перцентили относительно других игроков на этом же герое
function benchmarksLine(d) {
  const b = d.benchmarks || {};
  return [
    ['GPM', b.gold_per_min],
    ['добивание', b.last_hits_per_min],
    ['урон', b.hero_damage_per_min],
    ['KDA', b.kills_per_min],
  ]
    .filter(([, value]) => value?.pct != null)
    .map(([name, value]) => `${name} лучше ${pct(value.pct)}`)
    .join(', ');
}

function killersLine(d) {
  return Object.entries(d.killed_by || {})
    .map(([npc, count]) => [heroByNpc(npc), count])
    .filter(([hero]) => hero)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([hero, count]) => `${hero} ×${count}`)
    .join(', ');
}

// Когда куплены дорогие предметы (от 2000 золота), по первой покупке
function timingsLine(d) {
  const seen = new Set();
  const timings = [];
  for (const { time, key } of d.purchase_log || []) {
    const item = itemByKey(key);
    if (time <= 0 || !item || item.cost < 2000 || seen.has(key)) continue;
    seen.add(key);
    timings.push(`${item.name} на ${formatDuration(time)}`);
  }
  return timings.slice(0, 8).join(', ');
}

// --- Команды целиком (для сравнения) ---

function teamTotals(players, radiant) {
  const team = players.filter((p) => isRadiantSlot(p.player_slot) === radiant);
  const sum = (key) => team.reduce((acc, p) => acc + (p[key] || 0), 0);
  return {
    kills: sum('kills'),
    deaths: sum('deaths'),
    netWorth: sum('net_worth'),
    heroDamage: sum('hero_damage'),
    towerDamage: sum('tower_damage'),
  };
}

function teamsSection(info) {
  if (!info.match) return [];
  const lines = [true, false].map((radiant) => {
    const t = teamTotals(info.match.players, radiant);
    const others = info.match.players
      .filter((p) => isRadiantSlot(p.player_slot) === radiant && !info.ours.some((o) => o.slot === p.player_slot))
      .map((p) => `${heroName(p.hero_id)} ${p.kills}/${p.deaths}/${p.assists} nw ${short(p.net_worth ?? 0)} урон ${short(p.hero_damage ?? 0)}`);
    const totals = `убийств ${t.kills}, net worth ${short(t.netWorth)}, урон по героям ${short(t.heroDamage)}, по строениям ${short(t.towerDamage)}`;
    return `- ${sideName(radiant)} (итого: ${totals}): ${others.join('; ') || 'только наши'}`;
  });
  return section('Остальные участники — только для сравнения команд:', lines);
}

// --- График золота ---

const LEAD_THRESHOLD = 2000; // меньше — это ещё не «ведут»
const SWING_THRESHOLD = 3000; // минимальный перепад, чтобы считаться качелями
const SWING_WINDOW = 3; // минут

function goldSection(info) {
  const adv = info.match?.radiant_gold_adv; // преимущество Radiant по минутам, минус — ведёт Dire
  if (!adv?.length) return [];

  const points = [];
  for (let min = 5; min < adv.length; min += 5) points.push(`${min}' ${signed(adv[min])}`);
  points.push(`финал ${signed(adv.at(-1))}`);
  const lines = [`  ${points.join(' | ')}`];

  const maxRadiant = Math.max(...adv);
  const maxDire = Math.min(...adv);
  if (maxRadiant >= 1000) lines.push(`  Максимальное преимущество Radiant: +${short(maxRadiant)} на ${adv.indexOf(maxRadiant)}-й минуте`);
  if (maxDire <= -1000) lines.push(`  Максимальное преимущество Dire: +${short(-maxDire)} на ${adv.indexOf(maxDire)}-й минуте`);

  const changes = leadChanges(adv);
  if (changes.length) lines.push(`  Смены лидера: ${changes.join('; ')}`);

  const swings = biggestSwings(adv);
  if (swings.length) lines.push(`  Резкие качели: ${swings.join('; ')}`);

  return section('Преимущество по золоту (плюс — Radiant, минус — Dire):', lines);
}

function leadChanges(adv) {
  const changes = [];
  let leader = 0; // 1 — Radiant, -1 — Dire, 0 — пока никто
  adv.forEach((value, min) => {
    const now = value >= LEAD_THRESHOLD ? 1 : value <= -LEAD_THRESHOLD ? -1 : 0;
    if (now && leader && now !== leader) changes.push(`${min}' — вперёд вышли ${sideName(now > 0)}`);
    if (now) leader = now;
  });
  return changes;
}

// Три самых резких перепада золота за SWING_WINDOW минут, не перекрывающихся по времени
function biggestSwings(adv) {
  const windows = [];
  for (let min = 0; min + SWING_WINDOW < adv.length; min++) {
    windows.push({ min, delta: adv[min + SWING_WINDOW] - adv[min] });
  }
  windows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const picked = [];
  for (const w of windows) {
    if (Math.abs(w.delta) < SWING_THRESHOLD || picked.length >= 3) break;
    if (picked.every((p) => Math.abs(p.min - w.min) >= SWING_WINDOW)) picked.push(w);
  }
  return picked
    .sort((a, b) => a.min - b.min)
    .map((w) => `${w.min}'–${w.min + SWING_WINDOW}' ${sideName(w.delta > 0)} отыграли ${short(Math.abs(w.delta))}`);
}

// --- Хронология ---

const BUILDINGS = { tower1: 'T1', tower2: 'T2', tower3: 'T3', tower4: 'T4', melee_rax: 'казарму (ближ.)', range_rax: 'казарму (дальн.)', fort: 'ТРОН' };
const LANES = { top: 'верх', mid: 'мид', bot: 'низ' };
const RADIANT_TEAM = 2;
const MAX_FIGHTS = 8;

function timelineSection(info) {
  if (!info.match) return [];
  const events = [...objectiveEvents(info), ...fightEvents(info)].sort((a, b) => a.time - b.time);
  return section(
    'Хронология:',
    events.map((e) => `  [${formatDuration(e.time)}] ${e.text}`),
  );
}

// 'npc_dota_goodguys_tower1_top' → 'T1 верх (Radiant)'
function buildingName(key) {
  const m = key.match(/npc_dota_(goodguys|badguys)_(tower\d|melee_rax|range_rax|fort)(?:_(top|mid|bot))?/);
  if (!m) return null;
  const [, owner, building, lane] = m;
  return `${BUILDINGS[building]}${lane ? ` ${LANES[lane]}` : ''} (${owner === 'goodguys' ? 'Radiant' : 'Dire'})`;
}

function objectiveEvents(info) {
  const { players, objectives = [] } = info.match;
  const label = (p) => labelPlayer(info, p);
  // В объектах игрок указан то слотом (0–255), то индексом в players (0–9)
  const playerOf = (o) => players.find((p) => p.player_slot === o.player_slot) || players[o.slot];
  const events = [];

  for (const o of objectives) {
    const add = (text) => events.push({ time: o.time, text });
    switch (o.type) {
      case 'CHAT_MESSAGE_FIRSTBLOOD':
        add(`Первая кровь: ${label(playerOf(o))} убил ${label(players[o.key])}`);
        break;
      case 'CHAT_MESSAGE_ROSHAN_KILL':
        add(`Рошан убит командой ${sideName(o.team === RADIANT_TEAM)}`);
        break;
      case 'CHAT_MESSAGE_AEGIS':
        add(`Аегис забрал ${label(playerOf(o))}`);
        break;
      case 'CHAT_MESSAGE_COURIER_LOST':
        add(`${sideName(o.team === RADIANT_TEAM)} потеряли курьера`);
        break;
      case 'building_kill': {
        const building = buildingName(o.key || '');
        const killer = heroByNpc(o.unit);
        if (building) add(`Снесли ${building}${killer ? ` — добил ${killer}` : ''}`);
        break;
      }
    }
  }
  return events;
}

// Самые кровавые драки: кто сколько потерял, погиб ли кто-то из наших
function fightEvents(info) {
  const { players, teamfights = [] } = info.match;

  const fights = teamfights.map((fight) => {
    let radiantDeaths = 0;
    let direDeaths = 0;
    const oursDead = [];
    fight.players.forEach((fp, index) => {
      const p = players[index]; // игроки драки идут в том же порядке, что и в матче
      if (isRadiantSlot(p.player_slot)) radiantDeaths += fp.deaths;
      else direDeaths += fp.deaths;
      if (fp.deaths && info.ours.some((o) => o.slot === p.player_slot)) oursDead.push(labelPlayer(info, p));
    });
    return { fight, radiantDeaths, direDeaths, oursDead };
  });

  return fights
    .sort((a, b) => b.radiantDeaths + b.direDeaths - (a.radiantDeaths + a.direDeaths))
    .slice(0, MAX_FIGHTS)
    .map(({ fight, radiantDeaths, direDeaths, oursDead }) => {
      const winner = radiantDeaths < direDeaths ? 'Radiant' : direDeaths < radiantDeaths ? 'Dire' : 'никто';
      const ours = oursDead.length ? `; погибли наши: ${oursDead.join(', ')}` : '';
      return {
        time: fight.start,
        text: `Драка до ${formatDuration(fight.end)}: Radiant потеряли ${radiantDeaths}, Dire ${direDeaths} — выиграли ${winner}${ours}`,
      };
    });
}

// --- Чат ---

function chatSection(info) {
  const players = info.match?.players || [];
  const messages = (info.match?.chat || []).filter((c) => c.type === 'chat' && c.key?.trim());
  const lines = messages.slice(0, 25).map((c) => {
    const author = labelPlayer(info, players.find((p) => p.player_slot === c.player_slot));
    return `  [${formatDuration(c.time)}] ${author}: ${c.key.slice(0, 120)}`;
  });
  return section('Чат игроков (можно цитировать для шуток):', lines);
}

// --- Интересные факты ---

function factsSection(info) {
  const players = info.match?.players;
  if (!players) return [];

  const label = (p) => labelPlayer(info, p);
  const maxBy = (key) => players.reduce((a, b) => ((b[key] ?? -1) > (a[key] ?? -1) ? b : a));
  const kda = (p) => (p.kills + p.assists) / Math.max(1, p.deaths);
  const kdaText = (p) => `${p.kills}/${p.deaths}/${p.assists}`;

  const facts = [
    ['Больше всех убийств', 'kills'],
    ['Больше всех смертей', 'deaths'],
    ['Больше всех урона по героям', 'hero_damage'],
    ['Самый богатый (net worth)', 'net_worth'],
  ]
    .map(([title, key]) => [title, maxBy(key), key])
    .filter(([, p, key]) => p[key] != null)
    .map(([title, p, key]) => `- ${title}: ${label(p)} — ${p[key]}`);

  const best = players.reduce((a, b) => (kda(b) > kda(a) ? b : a));
  const worst = players.reduce((a, b) => (kda(b) < kda(a) ? b : a));
  facts.push(`- Лучший KDA в матче: ${label(best)} — ${kdaText(best)}`);
  facts.push(`- Худший KDA в матче: ${label(worst)} — ${kdaText(worst)}`);

  return section('Интересные факты:', facts);
}

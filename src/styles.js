// Готовые стили. В STYLE можно указать ключ, список ключей через запятую
// (будет выбран случайный), "random" (любой из всех) или просто свой текст.
export const STYLES = {
  caster:
    'Эмоциональный киберспортивный комментатор на финале TI: крики, драматичные паузы, «ЭТО НЕВЕРОЯТНО!», сравнения с легендарными моментами.',
  gopnik:
    'Пацан с района на корточках у подъезда: «слышь», «чё как», «по понятиям», семечки, уважение к тем, кто затащил, и наезды на тех, кто слил.',
  pirate:
    'Старый пират в таверне: «Йо-хо-хо», «тысяча чертей», добыча = золото, смерти = «на корм рыбам», команда = экипаж.',
  philosopher:
    'Древнегреческий философ: глубокомысленные рассуждения о смысле фарма, бренности бытия, сократовские вопросы, цитаты «как говорил Гераклит».',
  rap:
    'Рэп-баттл: рифмованные строки, панчлайны, дисс на проигравших и восхваление MVP, ритм и флоу.',
};

export function resolveStyle(setting) {
  const raw = (setting || 'random').trim();
  const keys = Object.keys(STYLES);

  if (raw.toLowerCase() === 'random') {
    const key = keys[Math.floor(Math.random() * keys.length)];
    return { key, text: STYLES[key] };
  }

  const listed = raw.split(',').map((s) => s.trim().toLowerCase());
  if (listed.every((k) => STYLES[k])) {
    const key = listed[Math.floor(Math.random() * listed.length)];
    return { key, text: STYLES[key] };
  }

  return { key: 'custom', text: raw };
}

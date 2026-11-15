// -----------------------------------------------------------------------------
// Visual Crossing icons (icons2 set), precipitation types and alerts -> the
// pivot values of Gladys (pure).
// -----------------------------------------------------------------------------

import { WEATHER_CONDITIONS as C } from '@gladysassistant/integration-sdk';

// The 16 icons of the documented `icons2` set. Anything else is `unknown`,
// never guessed.
const ICONS = {
  'clear-day': C.CLEAR,
  'clear-night': C.CLEAR,
  'partly-cloudy-day': C.PARTLY_CLOUDY,
  'partly-cloudy-night': C.PARTLY_CLOUDY,
  cloudy: C.CLOUD,
  fog: C.FOG,
  wind: C.WIND,
  rain: C.RAIN,
  'showers-day': C.RAIN,
  'showers-night': C.RAIN,
  snow: C.SNOW,
  'snow-showers-day': C.SNOW,
  'snow-showers-night': C.SNOW,
  'thunder-rain': C.THUNDERSTORM,
  'thunder-showers-day': C.THUNDERSTORM,
  'thunder-showers-night': C.THUNDERSTORM,
};

// mm in one hour from which rain is "pouring" (heavy rain, WMO: 7.6 mm/h).
const POURING_MM_H = 7.6;

/**
 * The condition of a record. `types` is its `preciptype` list (rain, snow,
 * freezingrain, ice), `hourlyPrecip` the mm of an hour (not of a day).
 */
export function toCondition(icon, { types = [], hourlyPrecip } = {}) {
  if (typeof icon !== 'string' || !Object.hasOwn(ICONS, icon)) return C.UNKNOWN;
  const base = ICONS[icon];
  const has = (t) => types.includes(t);
  if (base === C.THUNDERSTORM) return has('snow') && !has('rain') ? C.SNOW_THUNDERSTORM : base;
  if (base === C.SNOW) return has('rain') || has('ice') ? C.SLEET : base;
  if (base === C.RAIN) {
    if (has('freezingrain')) return C.FREEZING_RAIN;
    if (has('ice') || has('snow')) return C.SLEET;
    if (typeof hourlyPrecip === 'number' && hourlyPrecip >= POURING_MM_H) return C.POURING;
  }
  return base;
}

/** Day (true) or night (false) from the icon name; undefined when it says neither. */
export function iconDaylight(icon) {
  if (typeof icon !== 'string') return undefined;
  if (icon.endsWith('-day')) return true;
  if (icon.endsWith('-night')) return false;
  return undefined;
}

// Visual Crossing gives no alert level: it is read from the title (NWS
// "Warning/Watch/Advisory", MeteoAlarm colours, en/fr/de/es). Order matters:
// a "Yellow ... Warning" is moderate. No match: minor (never dropped).
const SEVERITIES = [
  ['extreme', /extreme|\bred\b|rouge|\brot\b|\brojo\b|emergency/],
  ['moderate', /yellow|jaune|\bgelb|amarill|moderate|modérée|watch/],
  ['severe', /orange|severe|warning|alerte|warnung|aviso/],
];
export const SEVERITY_RANK = { extreme: 4, severe: 3, moderate: 2, minor: 1 };

export function toSeverity(title) {
  if (typeof title !== 'string') return 'minor';
  // A US "Red Flag Warning" is a fire-weather warning, not a red level.
  const lower = title.toLowerCase().replace(/red flag/g, 'fire weather');
  return SEVERITIES.find(([, re]) => re.test(lower))?.[0] ?? 'minor';
}

// The phenomenon, from the alert title (English, French, German, Spanish).
// Order matters: "thunderstorm" before "storm", "wind chill" before "wind",
// "freezing rain" before "rain". No match: no type (the core keeps the text).
const TYPES = [
  ['thunderstorm', /thunder|orage|gewitter|tormenta/],
  ['avalanche', /avalanche|lawine|alud/],
  ['flood', /flood|inondation|crue|hochwasser|überflutung|inundaci/],
  ['coastal', /coastal|storm surge|high surf|rip current|submersion|vagues|sturmflut|costero/],
  ['cold', /wind chill|extreme cold|grand froid|kälte|frío/],
  ['snow', /snow|blizzard|ice storm|winter|freezing|neige|verglas|schnee|glätte|glatteis|nieve/],
  ['heat', /heat|canicule|chaleur|hitze|calor/],
  ['cold', /cold|frost|freeze|froid|gel\b/],
  ['wind', /wind|gale|hurricane|tornado|cyclone|vent|sturm|orkan|viento/],
  ['rain', /rain|pluie|regen|lluvia/],
  ['fog', /fog|brouillard|nebel|niebla/],
];

export function toAlertType(title) {
  if (typeof title !== 'string') return undefined;
  const lower = title.toLowerCase();
  return TYPES.find(([, re]) => re.test(lower))?.[0];
}

// -----------------------------------------------------------------------------
// The URLs of the Visual Crossing Timeline Weather API (pure). Coordinates are
// rounded to 3 decimals (about 100 m) before they leave Gladys. The metric
// unit group is always asked (°C, km/h, mm, cm, km, hPa); the US units are
// converted here, so one call serves every user of a location.
// -----------------------------------------------------------------------------

import { API_BASE } from './constants.js';

export const round3 = (value) => Math.round(value * 1000) / 1000;

// Only the elements used: a smaller answer, the same cost.
const ELEMENTS = [
  'datetime',
  'datetimeEpoch',
  'temp',
  'tempmax',
  'tempmin',
  'feelslike',
  'dew',
  'humidity',
  'precip',
  'precipprob',
  'preciptype',
  'snow',
  'windspeed',
  'windgust',
  'winddir',
  'pressure',
  'cloudcover',
  'visibility',
  'uvindex',
  'sunriseEpoch',
  'sunsetEpoch',
  'icon',
].join(',');

/**
 * The forecast without dates (15 days from today): Visual Crossing bills a
 * forecast query 1 record whatever its days and hours. Never a date range
 * (a past day is billed per record).
 */
export function forecastUrl({ latitude, longitude, alerts, key }) {
  const params = new URLSearchParams({
    unitGroup: 'metric',
    include: alerts ? 'current,days,hours,alerts' : 'current,days,hours',
    iconSet: 'icons2',
    elements: ELEMENTS,
    contentType: 'json',
    key,
  });
  return `${API_BASE}/${round3(latitude)},${round3(longitude)}?${params}`;
}

/** The current conditions only (the test button): 1 record. */
export function currentUrl({ latitude, longitude, key }) {
  const params = new URLSearchParams({
    unitGroup: 'metric',
    include: 'current',
    elements: 'datetime,datetimeEpoch,temp',
    contentType: 'json',
    key,
  });
  return `${API_BASE}/${round3(latitude)},${round3(longitude)}?${params}`;
}

/**
 * Retry-After in milliseconds: delta-seconds, or an HTTP date compared with
 * the server's own Date header (never with the local clock). Undefined when
 * unreadable.
 */
export function retryAfterMs(value, serverDate) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (/^\d{1,9}$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  const now = typeof serverDate === 'string' ? Date.parse(serverDate) : NaN;
  if (!Number.isFinite(at) || !Number.isFinite(now)) return undefined;
  return Math.max(0, at - now);
}

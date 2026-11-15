// -----------------------------------------------------------------------------
// A Visual Crossing answer -> a trimmed snapshot (what the cache keeps) -> the
// pivot weather of Gladys in the requested unit system (pure).
//
// The answer is asked in the metric unit group: °C, km/h, hPa, mm, cm (snow),
// km, and 0-100 percentages. Times are read from the `...Epoch` fields (UTC
// seconds), never from the local `datetime` texts.
// -----------------------------------------------------------------------------

import { MAX_ALERTS, MAX_DAYS, MAX_HOURS, MAX_QUERY_COST } from './constants.js';
import { SEVERITY_RANK, iconDaylight, toAlertType, toCondition, toSeverity } from './conditions.js';

// Strict values: a missing, null, text or non-finite value stays unknown.
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const pct = (v) => (num(v) !== undefined && v >= 0 && v <= 100 ? v : undefined);
const nonNeg = (v) => (num(v) !== undefined && v >= 0 ? v : undefined);
// Epoch seconds between 2000 and 2100, as milliseconds.
const epoch = (v) =>
  num(v) !== undefined && v > 946_684_800 && v < 4_102_444_800 ? v * 1000 : undefined;
const iso = (ms) => (ms === undefined ? undefined : new Date(ms).toISOString());
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g;
const str = (v, max) =>
  typeof v === 'string' ? v.replace(CONTROL, ' ').trim().slice(0, max) || undefined : undefined;
const line = (v, max) => str(typeof v === 'string' ? v.replace(/\s+/g, ' ') : v, max);
const code = (v) => (typeof v === 'string' && v.length <= 40 ? v : undefined);
const list = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const types = (v) =>
  list(v)
    .filter((t) => typeof t === 'string' && t.length <= 20)
    .slice(0, 6);

export class AnswerError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'AnswerError';
  }
}

function parseJson(text) {
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body;
  } catch {
    throw new AnswerError('unreadable answer');
  }
}

/**
 * The record cost Visual Crossing reports (`queryCost`), or undefined when it
 * is missing or unreadable (the caller then keeps its own count of 1).
 */
export function queryCost(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  const cost = obj(body).queryCost;
  return Number.isInteger(cost) && cost >= 0 ? Math.min(cost, MAX_QUERY_COST) : undefined;
}

function daylight(atMs, sunriseMs, sunsetMs, icon) {
  if (
    atMs !== undefined &&
    sunriseMs !== undefined &&
    sunsetMs !== undefined &&
    sunriseMs < sunsetMs
  ) {
    return atMs >= sunriseMs && atMs < sunsetMs;
  }
  return iconDaylight(icon);
}

/** Parse and trim a Timeline answer; throws an AnswerError. */
export function parseWeather(text) {
  const body = parseJson(text);
  const days = list(body.days)
    .slice(0, 16)
    .map((d) => ({
      startMs: epoch(d?.datetimeEpoch),
      min: num(d?.tempmin),
      max: num(d?.tempmax),
      icon: code(d?.icon),
      types: types(d?.preciptype),
      precipitation: nonNeg(d?.precip),
      precipitationProbability: pct(d?.precipprob),
      snow: nonNeg(d?.snow),
      uvIndex: nonNeg(d?.uvindex),
      humidity: pct(d?.humidity),
      windSpeed: nonNeg(d?.windspeed),
      windGust: nonNeg(d?.windgust),
      windDirection: num(d?.winddir),
      pressure: num(d?.pressure),
      sunriseMs: epoch(d?.sunriseEpoch),
      sunsetMs: epoch(d?.sunsetEpoch),
      hours: list(d?.hours).slice(0, 26),
    }))
    .filter((d) => d.startMs !== undefined && d.min !== undefined && d.max !== undefined)
    .sort((a, b) => a.startMs - b.startMs);
  const hours = [];
  for (const d of days) {
    for (const h of d.hours) {
      const startMs = epoch(h?.datetimeEpoch);
      const temperature = num(h?.temp);
      if (startMs === undefined || temperature === undefined) continue;
      const icon = code(h?.icon);
      hours.push({
        start: iso(startMs),
        temperature,
        apparent: num(h?.feelslike),
        humidity: pct(h?.humidity),
        pressure: num(h?.pressure),
        windSpeed: nonNeg(h?.windspeed),
        windGust: nonNeg(h?.windgust),
        windDirection: num(h?.winddir),
        cloudCover: pct(h?.cloudcover),
        visibility: nonNeg(h?.visibility),
        precipitation: nonNeg(h?.precip),
        precipitationProbability: pct(h?.precipprob),
        uvIndex: nonNeg(h?.uvindex),
        icon,
        types: types(h?.preciptype),
        daylight: daylight(startMs, d.sunriseMs, d.sunsetMs, icon),
      });
    }
    delete d.hours;
  }
  hours.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const cc = obj(body.currentConditions);
  const asOfMs = epoch(cc.datetimeEpoch);
  const ccIcon = code(cc.icon);
  const current = {
    asOf: iso(asOfMs),
    temperature: num(cc.temp),
    apparent: num(cc.feelslike),
    dewPoint: num(cc.dew),
    humidity: pct(cc.humidity),
    pressure: num(cc.pressure),
    windSpeed: nonNeg(cc.windspeed),
    windGust: nonNeg(cc.windgust),
    windDirection: num(cc.winddir),
    visibility: nonNeg(cc.visibility),
    cloudCover: pct(cc.cloudcover),
    uvIndex: nonNeg(cc.uvindex),
    precipitation: nonNeg(cc.precip),
    icon: ccIcon,
    types: types(cc.preciptype),
    sunrise: iso(epoch(cc.sunriseEpoch)),
    sunset: iso(epoch(cc.sunsetEpoch)),
    daylight: daylight(asOfMs, epoch(cc.sunriseEpoch), epoch(cc.sunsetEpoch), ccIcon),
  };
  if (current.asOf === undefined || current.temperature === undefined) {
    throw new AnswerError('answer without current conditions');
  }
  const seen = new Set();
  const alerts = list(body.alerts)
    .slice(0, 50)
    .map((a) => ({
      id: line(a?.id, 200),
      title: line(a?.event, 100),
      headline: line(a?.headline, 300),
      text: str(a?.description, 2000),
      start: iso(epoch(a?.onsetEpoch)),
      end: iso(epoch(a?.endsEpoch)),
    }))
    .filter((a) => {
      if (a.title === undefined) return false;
      const key = a.id ?? `${a.title}|${a.start}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    // The 10 most severe are kept (Gladys shows 10 at most).
    .sort((a, b) => SEVERITY_RANK[toSeverity(b.title)] - SEVERITY_RANK[toSeverity(a.title)])
    .slice(0, MAX_ALERTS);
  return {
    current,
    hours: hours.slice(0, 400),
    days: days.map((d, i) => ({
      ...d,
      endMs: days[i + 1]?.startMs ?? d.startMs + 86_400_000,
    })),
    alerts,
  };
}

/** Parse the answer of the test button: the time of its current conditions. */
export function parseCurrent(text) {
  const body = parseJson(text);
  const cc = obj(body.currentConditions);
  const asOf = iso(epoch(cc.datetimeEpoch));
  if (asOf === undefined || num(cc.temp) === undefined) {
    throw new AnswerError('answer without current conditions');
  }
  return { asOf };
}

const round = (v, digits = 1) => (v === undefined ? undefined : Number(v.toFixed(digits)));

function converters(units) {
  if (units === 'us') {
    return {
      temp: (c) => (c === undefined ? undefined : round((c * 9) / 5 + 32)),
      speed: (kmh) => (kmh === undefined ? undefined : round(kmh / 1.609344)),
      length: (mm) => (mm === undefined ? undefined : round(mm / 25.4, 2)),
      distance: (km) => (km === undefined ? undefined : round(km / 1.609344)),
    };
  }
  return {
    temp: (c) => round(c),
    speed: (kmh) => (kmh === undefined ? undefined : round(kmh / 3.6)),
    length: (mm) => round(mm),
    distance: (km) => round(km),
  };
}

// Only the known fields: an unknown value is left out, never sent as 0.
const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/**
 * The pivot weather. `nowMs` (wall clock) drops the past hours and days of a
 * kept copy; `serverNowMs` (the server's Date header + the time elapsed
 * since) drops the ended alerts; without it no alert is called ended.
 */
export function toPivot(snapshot, { units, nowMs, serverNowMs, alerts: withAlerts }) {
  const u = converters(units);
  const c = snapshot.current;
  const pivot = defined({
    temperature: u.temp(c.temperature),
    weather: toCondition(c.icon, { types: c.types, hourlyPrecip: c.precipitation }),
    datetime: c.asOf,
    apparent_temperature: u.temp(c.apparent),
    dew_point: u.temp(c.dewPoint),
    humidity: round(c.humidity, 0),
    pressure: round(c.pressure),
    wind_speed: u.speed(c.windSpeed),
    wind_gust: u.speed(c.windGust),
    wind_direction: round(c.windDirection, 0),
    visibility: u.distance(c.visibility),
    cloud_cover: round(c.cloudCover, 0),
    uv_index: round(c.uvIndex, 0),
    sunrise: c.sunrise,
    sunset: c.sunset,
    is_day: c.daylight,
  });
  pivot.hours = snapshot.hours
    .filter((h) => Date.parse(h.start) + 3600_000 > nowMs)
    .slice(0, MAX_HOURS)
    .map((h) =>
      defined({
        temperature: u.temp(h.temperature),
        weather: toCondition(h.icon, { types: h.types, hourlyPrecip: h.precipitation }),
        datetime: h.start,
        apparent_temperature: u.temp(h.apparent),
        humidity: round(h.humidity, 0),
        pressure: round(h.pressure),
        wind_speed: u.speed(h.windSpeed),
        wind_gust: u.speed(h.windGust),
        wind_direction: round(h.windDirection, 0),
        cloud_cover: round(h.cloudCover, 0),
        visibility: u.distance(h.visibility),
        precipitation: u.length(h.precipitation),
        precipitation_probability: round(h.precipitationProbability, 0),
        uv_index: round(h.uvIndex, 0),
        is_day: h.daylight,
      }),
    );
  pivot.days = snapshot.days
    .filter((d) => d.endMs > nowMs)
    .slice(0, MAX_DAYS)
    .map((d) =>
      defined({
        temperature_min: u.temp(d.min),
        temperature_max: u.temp(d.max),
        datetime: iso(d.startMs),
        weather: toCondition(d.icon, { types: d.types }),
        humidity: round(d.humidity, 0),
        pressure: round(d.pressure),
        wind_speed: u.speed(d.windSpeed),
        wind_gust: u.speed(d.windGust),
        wind_direction: round(d.windDirection, 0),
        precipitation: u.length(d.precipitation),
        precipitation_probability: round(d.precipitationProbability, 0),
        uv_index: round(d.uvIndex, 0),
        sunrise: iso(d.sunriseMs),
        sunset: iso(d.sunsetMs),
      }),
    );
  if (withAlerts) {
    pivot.alerts = snapshot.alerts
      .filter((a) => !(serverNowMs !== undefined && a.end && Date.parse(a.end) <= serverNowMs))
      .map((a) => ({ ...a, severity: toSeverity(a.title) }))
      .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
      .slice(0, MAX_ALERTS)
      .map((a) =>
        defined({
          severity: a.severity,
          event: a.title,
          type: toAlertType(a.title),
          description:
            [a.headline, a.text].filter(Boolean).join('\n\n').slice(0, 5000) || undefined,
          start: a.start,
          end: a.end,
        }),
      );
  }
  return pivot;
}

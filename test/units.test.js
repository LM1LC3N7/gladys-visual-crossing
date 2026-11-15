// -----------------------------------------------------------------------------
// The pure parts: configuration, icons, alert levels, answer parsing, URLs.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { toAlertType, toCondition, toSeverity } from '../src/conditions.js';
import { AnswerError, parseCurrent, parseWeather, queryCost, toPivot } from '../src/pivot.js';
import { currentUrl, forecastUrl, retryAfterMs } from '../src/visualcrossing.js';
import { API_KEY, CONFIG, weatherBody } from './helpers/fixtures.js';

const NOW = Date.parse('2026-11-15T10:00:00Z');

test('config: defaults, bounds, the key never echoed', () => {
  const ok = normalizeConfig(CONFIG);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.refreshMs, 3600_000);
  assert.equal(ok.value.dailyBudget, 500);
  assert.equal(ok.value.alerts, true);
  assert.match(ok.value.keyId, /^[0-9a-f]{64}$/);
  assert.equal(normalizeConfig({ api_key: `  ${API_KEY}\n` }).value.apiKey, API_KEY);
  assert.equal(normalizeConfig({}).configured, false);
  for (const bad of [
    'short',
    'has space 0123456789ABC',
    'ABCDEFGHIJ0123456789&x=1',
    'é'.repeat(20),
  ]) {
    const r = normalizeConfig({ api_key: bad });
    assert.deepEqual(r.errors, ['api_key'], bad);
    assert.ok(!JSON.stringify(r).includes(bad));
  }
  const cases = [
    [{ refresh_minutes: 59 }, ['refresh_minutes']],
    [{ refresh_minutes: 181 }, ['refresh_minutes']],
    [{ refresh_minutes: 90.5 }, ['refresh_minutes']],
    [{ refresh_minutes: '120' }, []],
    [{ daily_budget: 9 }, ['daily_budget']],
    [{ daily_budget: 100_001 }, ['daily_budget']],
    [{ daily_budget: '' }, []],
    [{ alerts: 'yes' }, ['alerts']],
  ];
  for (const [patch, errors] of cases) {
    assert.deepEqual(
      normalizeConfig({ ...CONFIG, ...patch }).errors,
      errors,
      JSON.stringify(patch),
    );
  }
  assert.notEqual(
    normalizeConfig(CONFIG).value.keyId,
    normalizeConfig({ api_key: 'TESTKEY0123456789ABCDEFGX' }).value.keyId,
  );
});

test('icons: the 16 of icons2, precipitation types, pouring on the hour only', () => {
  assert.equal(toCondition('clear-night'), 'clear');
  assert.equal(toCondition('partly-cloudy-day'), 'partly-cloudy');
  assert.equal(toCondition('cloudy'), 'cloud');
  assert.equal(toCondition('fog'), 'fog');
  assert.equal(toCondition('wind'), 'wind');
  assert.equal(toCondition('showers-night'), 'rain');
  assert.equal(toCondition('snow-showers-day'), 'snow');
  assert.equal(toCondition('thunder-rain'), 'thunderstorm');
  assert.equal(toCondition('thunder-showers-day', { types: ['snow'] }), 'snow-thunderstorm');
  assert.equal(toCondition('snow', { types: ['snow', 'rain'] }), 'sleet');
  assert.equal(toCondition('rain', { types: ['freezingrain'] }), 'freezing-rain');
  assert.equal(toCondition('rain', { types: ['ice'] }), 'sleet');
  assert.equal(toCondition('rain', { hourlyPrecip: 7.6 }), 'pouring');
  assert.equal(toCondition('rain', { hourlyPrecip: 7.5 }), 'rain');
  assert.equal(toCondition('rain', { types: ['rain'] }), 'rain'); // a day: never pouring
  for (const unknown of ['hail-storm', '', null, 3, '__proto__', 'constructor']) {
    assert.equal(toCondition(unknown), 'unknown', String(unknown));
  }
});

test('alert levels and phenomena from the title', () => {
  assert.equal(toSeverity('Red flood warning'), 'extreme');
  assert.equal(toSeverity('Vigilance rouge canicule'), 'extreme');
  assert.equal(toSeverity('Yellow thunderstorm warning'), 'moderate');
  assert.equal(toSeverity('Winter Storm Watch'), 'moderate');
  assert.equal(toSeverity('Orange wind warning'), 'severe');
  assert.equal(toSeverity('Winter Storm Warning'), 'severe');
  assert.equal(toSeverity('Red Flag Warning'), 'severe'); // fire weather, not a red level
  assert.equal(toSeverity('Special Weather Statement'), 'minor');
  assert.equal(toSeverity(undefined), 'minor');
  assert.equal(toAlertType('Orange thunderstorm warning'), 'thunderstorm');
  assert.equal(toAlertType('Wind Chill Advisory'), 'cold');
  assert.equal(toAlertType('Freezing Rain Advisory'), 'snow');
  assert.equal(toAlertType('Special notice'), undefined);
});

test('parse: epochs, hours flattened in order, days with their end', () => {
  const s = parseWeather(JSON.stringify(weatherBody()));
  assert.equal(s.current.asOf, '2026-11-15T10:00:00.000Z');
  assert.equal(s.hours.length, 15 * 24);
  assert.equal(s.hours[0].start, '2026-11-15T00:00:00.000Z');
  assert.equal(s.days.length, 15);
  assert.equal(s.days[0].endMs, s.days[1].startMs);
  assert.equal(s.days[14].endMs - s.days[14].startMs, 86_400_000);
  assert.equal(s.alerts.length, 3);
});

test('parse: unreadable, not an object, without current conditions', () => {
  for (const text of [
    '',
    'nope',
    '[]',
    'null',
    '{"days":[]}',
    JSON.stringify({ currentConditions: { temp: 3 } }),
  ]) {
    assert.throws(() => parseWeather(text), AnswerError, text);
  }
  const body = weatherBody();
  body.currentConditions.datetimeEpoch = 12; // 1970: not believed
  assert.throws(() => parseWeather(JSON.stringify(body)), AnswerError);
  assert.throws(() => parseCurrent('{}'), AnswerError);
  assert.deepEqual(parseCurrent(JSON.stringify(weatherBody())), {
    asOf: '2026-11-15T10:00:00.000Z',
  });
});

test('parse: hostile strings are cleaned and bounded; no prototype pollution', () => {
  const body = weatherBody();
  body.alerts = [
    { event: `A\u0000B${'x'.repeat(500)}`, description: 'y'.repeat(9000), id: 'z' },
    { event: 'Dup', id: 'd' },
    { event: 'Dup', id: 'd' },
    { headline: 'no event' },
  ];
  body.__proto__ = { polluted: true };
  const text = JSON.stringify(body).replace('"__proto__":{"polluted":true},', '');
  const s = parseWeather(text.replace('{', '{"__proto__":{"polluted":true},'));
  assert.equal(s.alerts.length, 2);
  assert.equal(s.alerts[0].title.length, 100);
  assert.ok(!s.alerts[0].title.includes(String.fromCharCode(0)));
  assert.equal(s.alerts[0].text.length, 2000);
  assert.equal({}.polluted, undefined);
});

test('queryCost: read when it is a whole number, else unknown', () => {
  assert.equal(queryCost('{"queryCost":1}'), 1);
  assert.equal(queryCost('{"queryCost":24}'), 24);
  assert.equal(queryCost('{"queryCost":99999999}'), 10_000);
  for (const t of ['{"queryCost":-1}', '{"queryCost":1.5}', '{"queryCost":"3"}', '{}', 'x', '[]']) {
    assert.equal(queryCost(t), undefined, t);
  }
});

test('pivot: a day at its end is dropped; at most 24 hours and 8 days', () => {
  const s = parseWeather(JSON.stringify(weatherBody()));
  const p = toPivot(s, {
    units: 'metric',
    nowMs: Date.parse('2026-11-16T00:00:00Z'),
    alerts: false,
  });
  assert.equal(p.days[0].datetime, '2026-11-16T00:00:00.000Z');
  assert.equal(p.hours[0].datetime, '2026-11-16T00:00:00.000Z');
  assert.equal(p.hours.length, 24);
  assert.equal(p.days.length, 8);
  assert.ok(!('alerts' in p));
});

test('pivot: day and night from the sun times, else from the icon', () => {
  const body = weatherBody('2026-11-15T20:00:00Z');
  const p = toPivot(parseWeather(JSON.stringify(body)), {
    units: 'metric',
    nowMs: NOW,
    alerts: false,
  });
  assert.equal(p.is_day, false);
  const polar = weatherBody(undefined, {
    current: { sunriseEpoch: undefined, sunsetEpoch: undefined, icon: 'clear-night' },
  });
  const q = toPivot(parseWeather(JSON.stringify(polar)), {
    units: 'metric',
    nowMs: NOW,
    alerts: false,
  });
  assert.equal(q.is_day, false);
  const none = weatherBody(undefined, { current: { sunriseEpoch: null, icon: 'rain' } });
  const r = toPivot(parseWeather(JSON.stringify(none)), {
    units: 'metric',
    nowMs: NOW,
    alerts: false,
  });
  assert.ok(!('is_day' in r));
});

test('urls: coordinates rounded, metric, never a date range; Retry-After', () => {
  const f = new URL(
    forecastUrl({ latitude: 48.85661, longitude: -2.35222, alerts: true, key: 'K' }),
  );
  assert.match(f.pathname, /\/timeline\/48\.857,-2\.352$/);
  assert.equal(f.searchParams.get('unitGroup'), 'metric');
  assert.match(f.searchParams.get('elements'), /datetimeEpoch/);
  const c = new URL(currentUrl({ latitude: 51.477, longitude: 0, key: 'K' }));
  assert.equal(c.searchParams.get('include'), 'current');
  assert.equal(retryAfterMs('120'), 120_000);
  assert.equal(
    retryAfterMs('Sun, 15 Nov 2026 03:05:00 GMT', 'Sun, 15 Nov 2026 03:00:00 GMT'),
    300_000,
  );
  assert.equal(retryAfterMs('Sun, 15 Nov 2026 03:05:00 GMT'), undefined);
  assert.equal(retryAfterMs('soon'), undefined);
});

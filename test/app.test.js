// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys, a fake Visual Crossing, a
// memory /data and a clock that advances.
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { VisualCrossingApp, refusalMark } from '../src/app.js';
import { normalizeConfig } from '../src/config.js';
import { ACTIONS } from '../src/constants.js';
import { Store } from '../src/store.js';
import { testClock } from './helpers/clock.js';
import {
  API_KEY,
  CONFIG,
  REQUEST,
  installFetch,
  json,
  memoryFs,
  memoryLogger,
  weatherBody,
} from './helpers/fixtures.js';

const MIN = 60_000;
const START = Date.parse('2026-11-15T10:00:00Z');
const SALT = '0123456789abcdef0123456789abcdef';
let fake;
const apps = [];
afterEach(async () => {
  fake?.restore();
  for (const app of apps.splice(0)) await app.stop();
});

async function setup({ config = CONFIG, initial, fs, handler, clock, autoStart = true } = {}) {
  clock ??= testClock({ start: START });
  fs ??= memoryFs(initial);
  const state = { handler: handler ?? (() => json(weatherBody())) };
  fake?.restore();
  fake = installFetch((call) => state.handler(call));
  const gladys = createFakeGladys({ selector: 'visual-crossing', config });
  const logger = memoryLogger();
  const app = new VisualCrossingApp({
    gladys,
    logger,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: new Store({ fs }),
  });
  apps.push(app);
  gladys.onWeatherGet((options) => app.getWeather(options));
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());
  await gladys.connect();
  if (autoStart) await app.onConnected();
  await clock.settle();
  return { app, gladys, clock, fs, logger, state };
}

// The status leaves through the host API: let it arrive.
const status = async (gladys) => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  return gladys.fake.connectionStatus;
};
const statuses = (gladys) => gladys.fake.connectionStatuses;
// A clock whose monotonic time can be pushed forward (time spent in a call).
const shiftable = (clock) => {
  const c = { ...clock, extra: 0 };
  c.monotonic = () => clock.monotonic() + c.extra;
  return c;
};
const OTHER = { ...REQUEST, latitude: 45.764, longitude: 4.8357 };
const noSecret = (text) => assert.ok(!text.includes(API_KEY), 'the key leaked');

test('not configured: nothing sent, the status says what to enter', async () => {
  const { gladys } = await setup({ config: {} });
  const ack = await gladys.fake.weatherGet(REQUEST);
  assert.equal(ack.success, false);
  assert.equal(fake.calls.length, 0);
  assert.equal((await status(gladys)).connected, false);
  assert.match((await status(gladys)).message.en, /API key of your Visual Crossing account/);
});

test('an invalid key is named, never repeated; nothing sent', async () => {
  const { gladys, logger } = await setup({ config: { api_key: 'bad key&x=1' } });
  const ack = await gladys.fake.weatherGet(REQUEST);
  assert.equal(ack.success, false);
  assert.equal(fake.calls.length, 0);
  assert.match((await status(gladys)).message.en, /Invalid configuration: API key/);
  assert.doesNotMatch(JSON.stringify(statuses(gladys)), /bad key/);
  assert.doesNotMatch(logger.lines.join('\n'), /bad key/);
});

test('the weather: one forecast call, metric conversions, alerts typed, copy reused', async () => {
  const { gladys, clock, fs, logger } = await setup();
  const ack = await gladys.fake.weatherGet(REQUEST);
  assert.equal(ack.success, true, ack.error);
  const w = ack.data.weather;
  assert.equal(w.temperature, 11.6);
  assert.equal(w.weather, 'partly-cloudy');
  assert.equal(w.datetime, '2026-11-15T10:00:00.000Z');
  assert.equal(w.humidity, 81);
  assert.equal(w.cloud_cover, 62);
  assert.equal(w.wind_speed, 5); // 18 km/h
  assert.equal(w.wind_gust, 10); // 36 km/h
  assert.equal(w.visibility, 23.5);
  assert.equal(w.pressure, 1012.4);
  assert.equal(w.dew_point, 8.5);
  assert.equal(w.is_day, true);
  assert.equal(w.sunrise, '2026-11-15T07:00:00.000Z');
  assert.equal(w.sunset, '2026-11-15T16:00:00.000Z');
  assert.equal(w.hours.length, 24);
  assert.equal(w.hours[0].datetime, '2026-11-15T10:00:00.000Z');
  assert.equal(w.hours[3].weather, 'pouring'); // 13:00, 9.2 mm in the hour
  assert.equal(w.hours[3].precipitation, 9.2);
  assert.equal(w.hours[3].precipitation_probability, 90);
  assert.equal(w.hours[3].wind_speed, 4);
  assert.equal(w.hours[0].is_day, true);
  assert.equal(w.hours[8].is_day, false); // 18:00, after sunset
  assert.equal(w.days.length, 8);
  assert.equal(w.days[0].datetime, '2026-11-15T00:00:00.000Z');
  assert.equal(w.days[1].weather, 'snow');
  assert.equal(w.days[0].wind_speed, 6);
  // the ended alert (09:00 < server Date 10:00) is dropped; no level -> minor
  assert.deepEqual(
    w.alerts.map((a) => [a.severity, a.type ?? null, a.event]),
    [
      ['severe', 'thunderstorm', 'Orange thunderstorm warning'],
      ['minor', null, 'Special notice'],
    ],
  );
  assert.equal(
    w.alerts[0].description,
    'Orange vigilance for thunderstorms\n\nThunderstorms with local hail.',
  );
  assert.equal(w.alerts[0].start, '2026-11-15T12:00:00.000Z');

  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0];
  assert.equal(call.url.origin, 'https://weather.visualcrossing.com');
  assert.equal(call.url.pathname, '/VisualCrossingWebServices/rest/services/timeline/48.857,2.352');
  const q = call.url.searchParams;
  assert.equal(q.get('unitGroup'), 'metric');
  assert.equal(q.get('include'), 'current,days,hours,alerts');
  assert.equal(q.get('iconSet'), 'icons2');
  assert.equal(q.get('key'), API_KEY);
  assert.equal(q.get('lang'), null);
  assert.equal(call.init.redirect, 'manual');
  assert.equal(call.init.headers.Accept, 'application/json');
  assert.match(
    call.init.headers['User-Agent'],
    /^gladys-visual-crossing\/\d+\.\d+\.\d+ \(\+https:/,
  );
  assert.equal((await status(gladys)).connected, true);
  assert.equal(fs.state().records, 1);
  assert.equal(fs.state().day, '2026-11-15');
  assert.deepEqual(fs.state().holds, []); // the hold of the call is lifted by its success
  // only what can still be served is kept in /data
  assert.ok(fs.state().cache[0].snapshot.hours.length <= 30);
  assert.ok(fs.state().cache[0].snapshot.days.length <= 9);

  // Within the refresh interval: the copy, no call.
  await clock.advance(59 * MIN);
  assert.equal((await gladys.fake.weatherGet(REQUEST)).success, true);
  assert.equal(fake.calls.length, 1);
  await clock.advance(1 * MIN);
  assert.equal((await gladys.fake.weatherGet(REQUEST)).success, true);
  assert.equal(fake.calls.length, 2);
  // the key never reaches /data, the logs or the statuses
  noSecret(JSON.stringify(fs.state()) + logger.lines.join('\n') + JSON.stringify(statuses(gladys)));
});

test('the past hours of a kept copy are dropped (wall clock)', async () => {
  const { gladys, clock } = await setup({ config: { ...CONFIG, refresh_minutes: 180 } });
  await gladys.fake.weatherGet(REQUEST);
  await clock.advance(150 * MIN);
  const w = (await gladys.fake.weatherGet(REQUEST)).data.weather;
  assert.equal(w.hours[0].datetime, '2026-11-15T12:00:00.000Z');
  assert.equal(w.datetime, '2026-11-15T10:00:00.000Z');
  assert.equal(fake.calls.length, 1);
});

test('us units: °F, mph, inches, miles; hPa kept', async () => {
  const { gladys } = await setup();
  const w = (await gladys.fake.weatherGet({ ...REQUEST, units: 'us' })).data.weather;
  assert.equal(w.temperature, 52.9);
  assert.equal(w.wind_speed, 11.2);
  assert.equal(w.visibility, 14.6);
  assert.equal(w.pressure, 1012.4);
  assert.equal(w.hours[3].precipitation, 0.36);
  assert.equal(w.days[0].temperature_max, 55.4);
  // one call serves both unit systems
  await gladys.fake.weatherGet(REQUEST);
  assert.equal(fake.calls.length, 1);
});

test('unknown values stay unknown: never sent as 0', async () => {
  const { gladys } = await setup({
    handler: () =>
      json(
        weatherBody(undefined, {
          current: { humidity: null, windspeed: '12', uvindex: undefined, cloudcover: 170 },
        }),
      ),
  });
  const w = (await gladys.fake.weatherGet(REQUEST)).data.weather;
  for (const field of ['humidity', 'wind_speed', 'uv_index', 'cloud_cover']) {
    assert.ok(!(field in w), field);
  }
});

test('alerts turned off: not asked, none answered', async () => {
  const { gladys } = await setup({ config: { ...CONFIG, alerts: false } });
  const w = (await gladys.fake.weatherGet(REQUEST)).data.weather;
  assert.ok(!('alerts' in w));
  assert.equal(fake.calls[0].url.searchParams.get('include'), 'current,days,hours');
});

test('without a readable Date header, no alert is called ended', async () => {
  const { gladys } = await setup({
    handler: () => json(weatherBody(), { headers: { date: 'nope' } }),
  });
  const w = (await gladys.fake.weatherGet(REQUEST)).data.weather;
  assert.equal(w.alerts.length, 3);
});

test('two requests at once for one location: one call', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { gladys } = await setup({ handler: async () => (await gate, json(weatherBody())) });
  const both = Promise.all([gladys.fake.weatherGet(REQUEST), gladys.fake.weatherGet(REQUEST)]);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const acks = await both;
  assert.deepEqual(
    acks.map((a) => a.success),
    [true, true],
  );
  assert.equal(fake.calls.length, 1);
});

test('two locations at once: one call in flight at a time', async () => {
  let inFlight = 0;
  let most = 0;
  const { gladys } = await setup({
    handler: async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return json(weatherBody());
    },
  });
  const acks = await Promise.all([
    gladys.fake.weatherGet(REQUEST),
    gladys.fake.weatherGet({ ...REQUEST, latitude: 45.764, longitude: 4.8357 }),
    gladys.fake.weatherGet({ ...REQUEST, latitude: 43.2965, longitude: 5.3698 }),
  ]);
  assert.deepEqual(
    acks.map((a) => a.success),
    [true, true, true],
  );
  assert.equal(fake.calls.length, 3);
  assert.equal(most, 1);
});

test('a 401 is a refusal at once (never retried); a salted byte in /data', async () => {
  const { gladys, fs, clock, logger } = await setup({
    handler: () => json('Invalid API key', { status: 401 }),
  });
  const ack = await gladys.fake.weatherGet(REQUEST);
  assert.equal(ack.success, false);
  assert.equal(fake.calls.length, 1);
  assert.match((await status(gladys)).message.en, /refused this API key/);
  const saved = fs.state();
  assert.match(saved.refused.id, /^[0-9a-f]{2}$/);
  assert.equal(saved.refused.id, refusalMark(saved.salt, normalizeConfig(CONFIG).value.keyId));
  noSecret(JSON.stringify(saved) + logger.lines.join('\n'));
  // never sent again on its own, even later, even after a restart
  await clock.advance(6 * 3600_000);
  await gladys.fake.weatherGet({ ...REQUEST, latitude: 1, longitude: 1 });
  assert.equal(fake.calls.length, 1);
  const again = await setup({ fs, clock });
  await again.gladys.fake.weatherGet(REQUEST);
  assert.equal(fake.calls.length, 0);
  assert.match((await status(again.gladys)).message.en, /refused this API key/);
});

test('a new key is always tried, while running or after a restart', async () => {
  const { app, gladys, fs, clock, state } = await setup({
    handler: () => json('', { status: 401 }),
  });
  await gladys.fake.weatherGet(REQUEST);
  assert.equal(fake.calls.length, 1);
  state.handler = () => json(weatherBody());
  await app.start({ api_key: 'NEWKEY0123456789ABCDEFGHI' });
  assert.equal((await gladys.fake.weatherGet(REQUEST)).success, true);
  assert.equal(fake.calls.length, 2);
  assert.equal(fs.state().refused, null);
  // after a restart: the byte of the old key does not match the new key's
  // (a fixed salt: no kept copy matches, and the two bytes differ)
  const saved = { ...fs.state(), salt: SALT };
  saved.refused = { id: refusalMark(SALT, normalizeConfig(CONFIG).value.keyId) };
  const other = normalizeConfig({ api_key: 'NEWKEY0123456789ABCDEFGHI' }).value.keyId;
  assert.notEqual(refusalMark(SALT, other), saved.refused.id);
  const again = await setup({
    initial: saved,
    clock,
    config: { api_key: 'NEWKEY0123456789ABCDEFGHI' },
  });
  assert.equal((await again.gladys.fake.weatherGet(REQUEST)).success, true);
  assert.equal(fake.calls.length, 1);
});

test('403 is not a refusal: a pause', async () => {
  const { gladys, fs } = await setup({ handler: () => json('Forbidden', { status: 403 }) });
  assert.equal((await gladys.fake.weatherGet(REQUEST)).success, false);
  assert.equal(fs.state().refused, null);
  assert.equal(fs.state().pause.reason, 'HTTP 403');
});

test('the test button: current conditions at a fixed point, tries a refused key, lifts it', async () => {
  const { gladys, fs, state } = await setup({ handler: () => json('', { status: 401 }) });
  await gladys.fake.weatherGet(REQUEST);
  assert.ok(fs.state().refused);
  state.handler = () => json(weatherBody());
  const ack = await gladys.fake.action(ACTIONS.TEST);
  assert.match(ack.data.message.en, /accepted the key/);
  assert.match(ack.data.message.en, /cost 1 record/);
  assert.match(ack.data.message.en, /today \(UTC\): 2 of 500/);
  const call = fake.calls.at(-1);
  assert.match(call.url.pathname, /\/timeline\/51\.477,0$/);
  assert.equal(call.url.searchParams.get('include'), 'current');
  assert.equal(fs.state().refused, null);
  assert.equal((await gladys.fake.weatherGet(REQUEST)).success, true);
  assert.equal((await status(gladys)).connected, true);
  noSecret(JSON.stringify(ack));
});

test('the test button: once a minute, and never during a pause', async () => {
  const { gladys, clock, state } = await setup();
  const first = await gladys.fake.action(ACTIONS.TEST);
  assert.match(first.data.message.en, /accepted/);
  const second = await gladys.fake.action(ACTIONS.TEST);
  assert.match(second.data.message.en, /less than a minute ago/);
  assert.equal(fake.calls.length, 1);
  await clock.advance(61_000);
  state.handler = () => json({}, { status: 429, headers: { 'retry-after': '600' } });
  await gladys.fake.action(ACTIONS.TEST);
  await clock.advance(61_000);
  const paused = await gladys.fake.action(ACTIONS.TEST);
  assert.match(paused.data.message.en, /HTTP 429/);
  assert.equal(fake.calls.length, 2);
  await clock.advance(600_000);
  state.handler = () => json(weatherBody());
  assert.match((await gladys.fake.action(ACTIONS.TEST)).data.message.en, /accepted/);
});

test('429: Retry-After followed, bounded to 6 hours, kept across a restart', async () => {
  const { gladys, clock, fs, state } = await setup({
    handler: () => json({}, { status: 429, headers: { 'retry-after': '120' } }),
  });
  assert.equal((await gladys.fake.weatherGet(REQUEST)).success, false);
  assert.match((await status(gladys)).message.en, /HTTP 429/);
  const other = { ...REQUEST, latitude: 45.764, longitude: 4.8357 };
  await clock.advance(119_000);
  await gladys.fake.weatherGet(other);
  assert.equal(fake.calls.length, 1);
  await clock.advance(2_000);
  state.handler = () => json({}, { status: 429, headers: { 'retry-after': '99999999' } });
  await gladys.fake.weatherGet(other);
  assert.equal(fake.calls.length, 2);
  const left = fs.state().pause.untilWall - clock.now();
  assert.ok(left <= 6 * 3600_000 && left > 6 * 3600_000 - 1000, String(left));

  // After a restart: still paused, nothing sent.
  const again = await setup({ fs, clock });
  assert.equal((await again.gladys.fake.weatherGet(REQUEST)).success, false);
  assert.equal(fake.calls.length, 0);
  await clock.advance(6 * 3600_000);
  assert.equal((await again.gladys.fake.weatherGet(REQUEST)).success, true);
});

test('429 with an HTTP date: compared with the server Date, not the local clock', async () => {
  const { gladys, clock } = await setup({
    handler: () =>
      json(
        {},
        {
          status: 429,
          headers: {
            date: 'Sun, 15 Nov 2026 03:00:00 GMT',
            'retry-after': 'Sun, 15 Nov 2026 03:05:00 GMT',
          },
        },
      ),
  });
  const other = { ...REQUEST, latitude: 45.764, longitude: 4.8357 };
  await gladys.fake.weatherGet(REQUEST);
  await clock.advance(4.9 * MIN);
  await gladys.fake.weatherGet(other);
  assert.equal(fake.calls.length, 1);
  await clock.advance(0.2 * MIN);
  await gladys.fake.weatherGet(other);
  assert.equal(fake.calls.length, 2);
});

test('a pause date from the future in /data is ignored', async () => {
  const clock = testClock({ start: START });
  const { gladys } = await setup({
    clock,
    initial: {
      salt: SALT,
      pause: { kind: 'error', reason: 'HTTP 500', untilWall: clock.now() + 30 * 86_400_000 },
    },
  });
  assert.equal((await gladys.fake.weatherGet(REQUEST)).success, true);
});

test('5xx: never retried, pause doubling from 60 s, the location held 15 min; the copy served with its own date', async () => {
  const { gladys, clock, state, fs } = await setup();
  await gladys.fake.weatherGet(REQUEST);
  state.handler = () => json('oops', { status: 503 });
  await clock.advance(60 * MIN);
  const stale = await gladys.fake.weatherGet(REQUEST);
  assert.equal(stale.success, true);
  assert.equal(stale.data.weather.datetime, '2026-11-15T10:00:00.000Z');
  assert.equal(fake.calls.length, 2);
  assert.match((await status(gladys)).message.en, /HTTP 503.*1 min/);
  assert.equal(fs.state().records, 2);
  // the location is held 15 min; another one may ask after the 60 s pause
  await clock.advance(61_000);
  await gladys.fake.weatherGet(REQUEST);
  assert.equal(fake.calls.length, 2);
  await gladys.fake.weatherGet({ ...REQUEST, latitude: 45.764, longitude: 4.8357 });
  assert.equal(fake.calls.length, 3);
  assert.match((await status(gladys)).message.en, /2 min/);
  await clock.advance(14 * MIN);
  await gladys.fake.weatherGet(REQUEST);
  assert.equal(fake.calls.length, 4);
  // beyond 4 hours, the old copy is never served
  await clock.advance(4 * 60 * MIN);
  const old = await gladys.fake.weatherGet(REQUEST);
  assert.equal(old.success, false);
});

test('a hold survives a restart: no new call for that location before its end', async () => {
  const { gladys, clock, fs } = await setup({ handler: () => json('oops', { status: 500 }) });
  await gladys.fake.weatherGet(REQUEST);
  assert.equal(fake.calls.length, 1);
  await clock.advance(5 * MIN);
  const again = await setup({ fs, clock });
  const ack = await again.gladys.fake.weatherGet(REQUEST);
  assert.equal(ack.success, false);
  assert.match(ack.error ?? '', /failed: asked again in 10 min/);
  assert.equal(fake.calls.length, 0);
  await clock.advance(10 * MIN);
  assert.equal((await again.gladys.fake.weatherGet(REQUEST)).success, true);
  assert.equal(fake.calls.length, 1);
});

test('a call that was cut by a restart (hold written before it left) is not repeated', async () => {
  const fs = memoryFs();
  const clock = testClock({ start: START });
  const { app } = await setup({ fs, clock, handler: () => new Promise(() => {}) });
  const pending = app.getWeather(REQUEST).catch(() => {});
  await clock.settle(10);
  assert.equal(fake.calls.length, 1);
  assert.equal(fs.state().records, 1);
  assert.equal(fs.state().holds.length, 1);
  await app.stop();
  const again = await setup({ fs, clock });
  assert.equal((await again.gladys.fake.weatherGet(REQUEST)).success, false);
  assert.equal(fake.calls.length, 0);
  void pending;
});

test('400: this location held one refresh interval, no global pause', async () => {
  const { gladys, clock, state, fs } = await setup({
    handler: () => json('Bad location', { status: 400 }),
  });
  assert.equal((await gladys.fake.weatherGet(REQUEST)).success, false);
  assert.equal(fs.state().pause, null);
  state.handler = () => json(weatherBody());
  assert.equal(
    (await gladys.fake.weatherGet({ ...REQUEST, latitude: 45.764, longitude: 4.8357 })).success,
    true,
  );
  await clock.advance(59 * MIN);
  const held = await gladys.fake.weatherGet(REQUEST);
  assert.match(held.error ?? '', /does not serve this location/);
  assert.equal(fake.calls.length, 2);
  await clock.advance(1 * MIN);
  assert.equal((await gladys.fake.weatherGet(REQUEST)).success, true);
});

test('a network failure or a timeout is never retried: one call, a pause', async () => {
  const { gladys, fs } = await setup({
    handler: () => {
      throw new TypeError('fetch failed');
    },
  });
  const ack = await gladys.fake.weatherGet(REQUEST);
  assert.equal(ack.success, false);
  assert.equal(fake.calls.length, 1);
  assert.equal(fs.state().pause.reason, 'no answer');
  assert.equal(fs.state().records, 1);
});

test('a hanging answer ends within the 13 s of a weather request', async (t) => {
  // AbortSignal.timeout does not hold the event loop: this interval does.
  const keep = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keep));
  const { app, clock } = await setup({ handler: () => new Promise(() => {}) });
  const started = Date.now();
  const outcome = await app.getWeather(REQUEST).then(
    () => 'ok',
    (e) => e.message,
  );
  assert.match(outcome, /timeout/);
  assert.ok(Date.now() - started < 12_000);
  void clock;
});

test('an answer too large is cut before it is read whole, and pauses', async () => {
  const big = JSON.stringify({ pad: 'x'.repeat(1_100_000) });
  const { gladys, fs } = await setup({ handler: () => ({ status: 200, body: big }) });
  const ack = await gladys.fake.weatherGet(REQUEST);
  assert.equal(ack.success, false);
  assert.match(ack.error ?? JSON.stringify(ack), /too large/);
  assert.equal(fs.state().pause.kind, 'error');
});

test('an answer without current conditions is not a refusal', async () => {
  const { gladys, fs } = await setup({ handler: () => json({ queryCost: 1, days: [] }) });
  assert.equal((await gladys.fake.weatherGet(REQUEST)).success, false);
  assert.equal(fs.state().refused, null);
  assert.equal(fs.state().pause.reason, 'answer without current conditions');
});

test('the queryCost of the answer is counted (a forecast costing more is seen)', async () => {
  const { gladys, fs, logger } = await setup({
    handler: () => json(weatherBody(undefined, { top: { queryCost: 24 } })),
  });
  await gladys.fake.weatherGet(REQUEST);
  assert.equal(fs.state().records, 24);
  assert.match(logger.lines.join('\n'), /cost 24 records/);
});

test('the daily cap: reached, nothing sent until midnight UTC', async () => {
  const clock = testClock({ start: START });
  const { gladys } = await setup({
    clock,
    config: { ...CONFIG, daily_budget: 10 },
    initial: { salt: SALT, day: '2026-11-15', records: 10 },
  });
  assert.equal((await gladys.fake.weatherGet(REQUEST)).success, false);
  assert.equal(fake.calls.length, 0);
  assert.match((await status(gladys)).message.en, /Daily cap reached \(10 records\)/);
  clock.jumpWall(14 * 3600_000);
  assert.equal((await gladys.fake.weatherGet(REQUEST)).success, true);
  assert.equal(fake.calls.length, 1);
});

test('the daily cap: the last record is used, never one more', async () => {
  const { gladys } = await setup({
    config: { ...CONFIG, daily_budget: 10 },
    initial: { salt: SALT, day: '2026-11-15', records: 9 },
  });
  assert.equal((await gladys.fake.weatherGet(REQUEST)).success, true);
  assert.equal(
    (await gladys.fake.weatherGet({ ...REQUEST, latitude: 45.764, longitude: 4.8357 })).success,
    false,
  );
  assert.equal(fake.calls.length, 1);
});

test('a wall clock set back never resets the count of a later day', async () => {
  const clock = testClock({ start: START });
  const { gladys } = await setup({
    clock,
    config: { ...CONFIG, daily_budget: 10 },
    initial: { salt: SALT, day: '2026-11-16', records: 10 },
  });
  assert.equal((await gladys.fake.weatherGet(REQUEST)).success, false);
  assert.equal(fake.calls.length, 0);
});

test('every call is counted in /data before it leaves', async () => {
  let savedBefore;
  const fs = memoryFs();
  await setup({
    fs,
    handler: () => {
      savedBefore = fs.state().records;
      return json(weatherBody());
    },
  }).then(({ gladys }) => gladys.fake.weatherGet(REQUEST));
  assert.equal(savedBefore, 1);
});

test('a count that cannot be written: nothing sent', async () => {
  const fs = memoryFs();
  const { gladys, app, clock } = await setup({ fs });
  await clock.settle();
  fs.failWrites = true;
  const ack = await gladys.fake.weatherGet(REQUEST);
  assert.equal(ack.success, false);
  assert.match(ack.error ?? '', /could not be counted/);
  assert.equal(fake.calls.length, 0);
  // a slow write: nothing sent either, within its bound
  fs.failWrites = false;
  fs.slowWrites = true;
  const pending = app.getWeather(REQUEST).then(
    () => 'ok',
    (e) => e.message,
  );
  await clock.settle(10);
  await clock.advance(1_100);
  assert.match(await pending, /could not be counted/);
  assert.equal(fake.calls.length, 0);
  fs.slowWrites = false;
  fs.releaseWrites();
});

test('a restart serves the kept copy (its own date), no call within the interval', async () => {
  const { gladys, fs, clock } = await setup();
  await gladys.fake.weatherGet(REQUEST);
  const saved = JSON.stringify(fs.state());
  assert.doesNotMatch(saved, /48\.85|2\.35/); // no coordinates in /data
  await clock.advance(30 * MIN);
  const again = await setup({ fs, clock });
  const ack = await again.gladys.fake.weatherGet(REQUEST);
  assert.equal(ack.success, true);
  assert.equal(ack.data.weather.datetime, '2026-11-15T10:00:00.000Z');
  assert.equal(fake.calls.length, 0);
});

test('a kept copy dated in the future is dropped at restart', async () => {
  const { gladys, fs, clock } = await setup();
  await gladys.fake.weatherGet(REQUEST);
  const saved = fs.state();
  saved.cache[0].fetchedWall = clock.now() + 3600_000;
  saved.holds = [];
  const again = await setup({ initial: saved, clock });
  await again.gladys.fake.weatherGet(REQUEST);
  assert.equal(fake.calls.length, 1);
});

test('/data unreadable is not empty: nothing sent, read again every 10 s', async () => {
  const clock = testClock({ start: START });
  const fs = memoryFs({ salt: SALT, refused: null });
  fs.broken = true;
  const { gladys } = await setup({ fs, clock });
  assert.equal((await gladys.fake.weatherGet(REQUEST)).success, false);
  assert.equal(fake.calls.length, 0);
  assert.match((await status(gladys)).message.en, /unreadable/);
  const reads = fs.reads;
  await clock.advance(9_000);
  assert.equal(fs.reads, reads);
  fs.broken = false;
  await clock.advance(1_500);
  assert.equal(fs.reads, reads + 1);
  // read again: the status says so at once, without waiting for a call
  assert.equal((await status(gladys)).connected, true);
  assert.equal(fake.calls.length, 0);
  assert.equal((await gladys.fake.weatherGet(REQUEST)).success, true);
  assert.equal(fs.state().salt, SALT);
});

test('/data that hangs: the request fails within its bound, one read at a time', async () => {
  const clock = testClock({ start: START });
  const fs = memoryFs();
  fs.slow = true;
  const { app } = await setup({ fs, clock, autoStart: false });
  const starting = app.start(CONFIG);
  await clock.advance(2_100);
  await starting;
  const pending = app.getWeather(REQUEST).then(
    () => 'ok',
    (e) => e.message,
  );
  await clock.advance(2_100);
  assert.match(await pending, /unreadable/);
  await clock.advance(60_000);
  assert.equal(fs.reads, 1);
  assert.equal(fake.calls.length, 0);
});

test('getConfig failing in connected: retried, spaced, then the integration starts', async () => {
  const clock = testClock({ start: START });
  const { app, gladys } = await setup({ clock, autoStart: false });
  const real = gladys.getConfig.bind(gladys);
  let fails = 2;
  gladys.getConfig = async () => {
    if (fails-- > 0) throw new Error('host down');
    return real();
  };
  await app.onConnected();
  assert.match((await status(gladys)).message.en, /new try in 5 s/);
  await clock.advance(5_000);
  assert.match((await status(gladys)).message.en, /new try in 10 s/);
  await clock.advance(10_000);
  await clock.settle();
  assert.equal((await status(gladys)).connected, true);
  assert.equal((await gladys.fake.weatherGet(REQUEST)).success, true);
});

test('a reconnection or a saved configuration never makes a call by itself', async () => {
  const { app, gladys, clock } = await setup();
  await gladys.fake.weatherGet(REQUEST);
  await app.onConnected();
  await app.start(CONFIG);
  await clock.advance(10 * MIN);
  assert.equal(fake.calls.length, 1);
  assert.equal((await gladys.fake.weatherGet(REQUEST)).success, true);
  assert.equal(fake.calls.length, 1);
});

test('bad coordinates: refused, nothing sent', async () => {
  const { gladys } = await setup();
  for (const bad of [{ latitude: 91, longitude: 0 }, { latitude: '1', longitude: 2 }, {}]) {
    assert.equal((await gladys.fake.weatherGet({ ...bad, units: 'metric' })).success, false);
  }
  assert.equal(fake.calls.length, 0);
});

test('stop leaves no timer and no call', async () => {
  const clock = testClock({ start: START });
  const fs = memoryFs();
  fs.broken = true;
  const { app } = await setup({ fs, clock });
  await app.stop();
  assert.equal(clock.pending.size, 0);
  assert.equal(fake.calls.length, 0);
});

test('a slow answer for one location: the next one still leaves (whole-ms timeout), no pause', async () => {
  const clock = shiftable(testClock({ start: START }));
  const { gladys, fs } = await setup({ clock });
  let n = 0;
  fake.restore();
  fake = installFetch(() => {
    // the first call takes 3.2005 s: the second waits for it in the queue
    if (n++ === 0) clock.extra += 3_200.5;
    return json(weatherBody());
  });
  const acks = await Promise.all([gladys.fake.weatherGet(REQUEST), gladys.fake.weatherGet(OTHER)]);
  assert.deepEqual(
    acks.map((a) => a.success),
    [true, true],
  );
  assert.equal(fake.calls.length, 2);
  assert.equal(fs.state().records, 2);
  assert.equal(fs.state().pause, null);
});

test('a local error before the request: no record, no hold, no pause', async () => {
  const { app, fs, clock } = await setup();
  await clock.settle();
  const err = await app
    .call(
      () => {
        throw new RangeError('bad timeout');
      },
      app.config,
      app.gen,
      { holdKey: 'a'.repeat(64), deadline: clock.monotonic() + 13_000 },
    )
    .catch((e) => e);
  assert.match(err.message, /could not be prepared: nothing sent/);
  await clock.settle();
  assert.equal(fake.calls.length, 0);
  assert.equal(fs.state().records, 0);
  assert.deepEqual(fs.state().holds, []);
  assert.equal(fs.state().pause, null);
});

test('the deadline is checked again after the count is written: too late, nothing sent', async () => {
  const clock = shiftable(testClock({ start: START }));
  const fs = memoryFs();
  const { gladys } = await setup({ clock, fs });
  const write = fs.writeFile;
  let bumped = false;
  fs.writeFile = async (...args) => {
    if (!bumped && args[1].includes('"records":1')) {
      bumped = true;
      clock.extra += 11_500; // the write took 11.5 s of the 13
    }
    return write(...args);
  };
  const ack = await gladys.fake.weatherGet(REQUEST);
  assert.equal(ack.success, false);
  assert.match(ack.error ?? '', /nothing sent/);
  assert.equal(fake.calls.length, 0);
  await clock.settle();
  assert.equal(fs.state().records, 0);
});

test('the HTTP timeout follows the 13 s of the request, not only its own 10 s', async (t) => {
  const keep = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keep));
  const clock = shiftable(testClock({ start: START }));
  const fs = memoryFs();
  const { app } = await setup({ clock, fs, handler: () => new Promise(() => {}) });
  const write = fs.writeFile;
  let bumped = false;
  fs.writeFile = async (...args) => {
    if (!bumped) {
      bumped = true;
      clock.extra += 10_500; // 2.5 s left
    }
    return write(...args);
  };
  const started = Date.now();
  const outcome = await app.getWeather(REQUEST).then(
    () => 'ok',
    (e) => e.message,
  );
  const took = Date.now() - started;
  assert.match(outcome, /timeout/);
  assert.ok(took >= 2_000 && took < 5_000, `${took} ms`);
});

test('a Retry-After of 0 still pauses 60 s (never a storm)', async () => {
  const { gladys, clock } = await setup({
    handler: () => json({}, { status: 429, headers: { 'retry-after': '0' } }),
  });
  await gladys.fake.weatherGet(REQUEST);
  await clock.advance(30_000);
  await gladys.fake.weatherGet(OTHER);
  assert.equal(fake.calls.length, 1);
  await clock.advance(31_000);
  await gladys.fake.weatherGet(OTHER);
  assert.equal(fake.calls.length, 2);
});

test('a queryCost of 0 never lowers the count', async () => {
  const { gladys, fs } = await setup({
    handler: () => json(weatherBody(undefined, { top: { queryCost: 0 } })),
  });
  assert.equal((await gladys.fake.weatherGet(REQUEST)).success, true);
  assert.equal(fs.state().records, 1);
});

for (const [name, handler] of [
  ['a network failure', () => Promise.reject(new TypeError('fetch failed'))],
  ['a 429', () => json({}, { status: 429, headers: { 'retry-after': '60' } })],
  ['an unreadable 200', () => json('<html>busy</html>')],
]) {
  test(`after ${name}, this location waits 15 min although the pause ends sooner`, async () => {
    const { gladys, clock, state } = await setup({ handler });
    assert.equal((await gladys.fake.weatherGet(REQUEST)).success, false);
    state.handler = () => json(weatherBody());
    await clock.advance(61_000);
    await gladys.fake.weatherGet(REQUEST);
    assert.equal(fake.calls.length, 1);
    assert.equal((await gladys.fake.weatherGet(OTHER)).success, true);
    assert.equal(fake.calls.length, 2);
    await clock.advance(14 * MIN);
    assert.equal((await gladys.fake.weatherGet(REQUEST)).success, true);
    assert.equal(fake.calls.length, 3);
  });
}

test('stop cancels the getConfig retry: no timer, no new read', async () => {
  const clock = testClock({ start: START });
  const { app, gladys } = await setup({ clock, autoStart: false });
  let reads = 0;
  gladys.getConfig = async () => {
    reads += 1;
    throw new Error('host down');
  };
  await app.onConnected();
  assert.equal(reads, 1);
  await app.stop();
  assert.equal(clock.pending.size, 0);
  await clock.advance(10 * MIN);
  assert.equal(reads, 1);
});

test('a clock that jumps forward then back never freezes the daily cap', async () => {
  const clock = testClock({ start: START });
  const { gladys, fs } = await setup({ clock, config: { ...CONFIG, daily_budget: 10 } });
  clock.jumpWall(40 * 86_400_000);
  assert.equal((await gladys.fake.weatherGet(REQUEST)).success, true);
  assert.equal(fs.state().day, '2026-12-25');
  clock.jumpWall(-40 * 86_400_000);
  assert.equal((await gladys.fake.weatherGet(OTHER)).success, true);
  await clock.settle();
  assert.equal(fs.state().day, '2026-11-15');
  assert.equal(fs.state().records, 2); // kept, on the safe side
});

test('a count filed under a far day in /data: blocked today only, reset at midnight UTC', async () => {
  const clock = testClock({ start: START });
  const { gladys } = await setup({
    clock,
    config: { ...CONFIG, daily_budget: 10 },
    initial: { salt: SALT, day: '2026-12-25', records: 10 },
  });
  assert.equal((await gladys.fake.weatherGet(REQUEST)).success, false);
  assert.match((await status(gladys)).message.en, /before midnight UTC/);
  clock.jumpWall(14 * 3600_000);
  assert.equal((await gladys.fake.weatherGet(REQUEST)).success, true);
});

test('5xx: Retry-After followed, within 60 s - 1 h', async () => {
  const { gladys, clock, fs, state } = await setup({
    handler: () => json('busy', { status: 503, headers: { 'retry-after': '1800' } }),
  });
  await gladys.fake.weatherGet(REQUEST);
  await clock.advance(29 * MIN);
  await gladys.fake.weatherGet(OTHER);
  assert.equal(fake.calls.length, 1);
  await clock.advance(2 * MIN);
  state.handler = () => json('busy', { status: 503, headers: { 'retry-after': '99999' } });
  await gladys.fake.weatherGet(OTHER);
  assert.equal(fake.calls.length, 2);
  const left = fs.state().pause.untilWall - clock.now();
  assert.ok(left <= 3600_000 && left > 3600_000 - 1000, String(left));
});

test('the doubling step survives a restart after its pause; a success resets it', async () => {
  const clock = testClock({ start: START });
  const { gladys, fs } = await setup({ clock, handler: () => json('x', { status: 503 }) });
  await gladys.fake.weatherGet(REQUEST);
  await clock.advance(61_000);
  await gladys.fake.weatherGet(OTHER); // 2 min
  await clock.advance(3 * MIN);
  const again = await setup({ fs, clock, handler: () => json('x', { status: 503 }) });
  await again.gladys.fake.weatherGet({ ...REQUEST, latitude: 1, longitude: 1 });
  assert.match((await status(again.gladys)).message.en, /HTTP 503.*4 min/);
  again.state.handler = () => json(weatherBody());
  await clock.advance(5 * MIN);
  assert.equal(
    (await again.gladys.fake.weatherGet({ ...REQUEST, latitude: 2, longitude: 2 })).success,
    true,
  );
  await clock.settle();
  assert.equal(fs.state().step, 0);
});

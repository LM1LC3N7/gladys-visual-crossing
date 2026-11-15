// -----------------------------------------------------------------------------
// Test material: a Visual Crossing Timeline answer shaped after the official
// documentation (metric unit group, icons2), a fake fetch, a memory /data and
// a logger that keeps every line. The key is made up (never a real one).
// -----------------------------------------------------------------------------

import { setFetch } from '../../src/http.js';

export const API_KEY = 'TESTKEY0123456789ABCDEFGH';
export const CONFIG = { api_key: API_KEY };

export const REQUEST = { latitude: 48.85661, longitude: 2.35222, language: 'fr', units: 'metric' };

const s = (iso) => Date.parse(iso) / 1000;

/**
 * A Timeline answer whose current conditions are at `nowIso`. Days start at
 * midnight UTC (a location at UTC+0, to keep the arithmetic readable).
 */
export function weatherBody(nowIso = '2026-11-15T10:00:00Z', patch = {}) {
  const day0 = s(`${nowIso.slice(0, 10)}T00:00:00Z`);
  return {
    queryCost: 1,
    latitude: 48.857,
    longitude: 2.352,
    resolvedAddress: '48.857,2.352',
    address: '48.857,2.352',
    timezone: 'Etc/UTC',
    tzoffset: 0,
    days: Array.from({ length: 15 }, (_, i) => {
      const start = day0 + i * 86400;
      return {
        datetime: new Date(start * 1000).toISOString().slice(0, 10),
        datetimeEpoch: start,
        tempmax: 13 + i,
        tempmin: 5,
        temp: 9,
        humidity: 78.4,
        precip: 1.5,
        precipprob: 35,
        preciptype: i === 1 ? ['snow'] : ['rain'],
        snow: i === 1 ? 2 : 0,
        windspeed: 21.6,
        windgust: 40,
        winddir: 200,
        pressure: 1013.2,
        cloudcover: 60,
        visibility: 20,
        uvindex: 2,
        sunriseEpoch: start + 7 * 3600,
        sunsetEpoch: start + 16 * 3600,
        icon: i === 1 ? 'snow' : 'partly-cloudy-day',
        hours: Array.from({ length: 24 }, (__, h) => ({
          datetime: `${String(h).padStart(2, '0')}:00:00`,
          datetimeEpoch: start + h * 3600,
          temp: 5 + h / 4,
          feelslike: 4,
          dew: 3,
          humidity: 80,
          precip: h === 13 ? 9.2 : 0,
          precipprob: h === 13 ? 90 : 10,
          preciptype: h === 13 ? ['rain'] : null,
          windspeed: 14.4,
          windgust: 30,
          winddir: 220,
          pressure: 1012,
          cloudcover: 50,
          visibility: 15,
          uvindex: 1,
          icon: h === 13 ? 'rain' : 'cloudy',
        })),
      };
    }),
    alerts: [
      {
        event: 'Orange thunderstorm warning',
        headline: 'Orange vigilance for thunderstorms',
        ends: '2026-11-15T20:00:00',
        endsEpoch: s('2026-11-15T20:00:00Z'),
        onset: '2026-11-15T12:00:00',
        onsetEpoch: s('2026-11-15T12:00:00Z'),
        id: 'a-1',
        language: 'en',
        link: 'https://example.org/a-1',
        description: 'Thunderstorms with local hail.',
      },
      {
        event: 'Yellow wind warning',
        headline: 'Yellow vigilance for wind',
        endsEpoch: s('2026-11-15T09:00:00Z'),
        onsetEpoch: s('2026-11-15T06:00:00Z'),
        id: 'a-2',
        description: 'Gusts up to 70 km/h.',
      },
      { event: 'Special notice', id: 'a-3' },
    ],
    currentConditions: {
      datetime: nowIso.slice(11, 19),
      datetimeEpoch: s(nowIso),
      temp: 11.6,
      feelslike: 9.9,
      humidity: 81,
      dew: 8.5,
      precip: 0,
      precipprob: 0,
      preciptype: null,
      snow: 0,
      windgust: 36,
      windspeed: 18,
      winddir: 225,
      pressure: 1012.4,
      visibility: 23.5,
      cloudcover: 62,
      uvindex: 1,
      icon: 'partly-cloudy-day',
      sunriseEpoch: day0 + 7 * 3600,
      sunsetEpoch: day0 + 16 * 3600,
      ...patch.current,
    },
    ...patch.top,
  };
}

export const json = (body, { status = 200, headers = {} } = {}) => ({
  status,
  body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: {
    'content-type': 'application/json',
    date: 'Sun, 15 Nov 2026 10:00:00 GMT',
    ...headers,
  },
});

/**
 * Replace fetch: `handler(call)` returns `{ status, body, headers }`, throws,
 * or never resolves (the request then ends on its AbortSignal).
 */
export function installFetch(handler) {
  const calls = [];
  const previous = setFetch(async (url, init) => {
    const call = { url: new URL(url), init };
    calls.push(call);
    const result = await Promise.race([
      handler(call),
      new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      }),
    ]);
    return new Response(result.body ?? '', {
      status: result.status ?? 200,
      headers: result.headers ?? {},
    });
  });
  return { calls, restore: () => setFetch(previous) };
}

/** A /data in memory; `broken`/`slow` make reads fail or hang. */
export function memoryFs(initial) {
  const files = new Map(initial ? [['/data/state.json', JSON.stringify(initial)]] : []);
  const fs = {
    files,
    reads: 0,
    writes: [],
    broken: false,
    slow: false,
    slowWrites: false,
    held: [],
    releaseWrites: () => fs.held.splice(0).forEach((resolve) => resolve()),
    failWrites: false,
    async readFile(path) {
      fs.reads += 1;
      if (fs.slow) return new Promise(() => {});
      if (fs.broken) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      if (!files.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files.get(path);
    },
    async writeFile(path, text) {
      if (fs.slowWrites) {
        await new Promise((resolve) => fs.held.push(resolve));
      }
      if (fs.failWrites) throw Object.assign(new Error('EROFS'), { code: 'EROFS' });
      fs.writes.push(text);
      files.set(path, text);
    },
    async rename(from, to) {
      files.set(to, files.get(from));
      files.delete(from);
    },
    state: () => JSON.parse(files.get('/data/state.json') ?? '{}'),
  };
  return fs;
}

/** A logger that keeps every line (to check that no secret is written). */
export function memoryLogger() {
  const lines = [];
  const keep =
    (level) =>
    (...args) =>
      lines.push(
        `${level} ${args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')}`,
      );
  return {
    lines,
    info: keep('info'),
    warn: keep('warn'),
    error: keep('error'),
    debug: keep('debug'),
  };
}

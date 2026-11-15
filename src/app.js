// -----------------------------------------------------------------------------
// VisualCrossingApp: the weather provider. Answers Gladys from a per-location
// copy (never read faster than the refresh interval), counts the records of
// the UTC day BEFORE each call (on disk, or nothing leaves), never retries a
// call that may have been billed, sends one call at a time, pauses after
// 429/5xx, stops after a refused key, and keeps all of it in /data.
//
// Clocks: `monotonic` decides (copy age, holds, pauses, test spacing); `now`
// (wall) only names the day, dates /data and drops the past hours of a copy.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { logger as sdkLogger } from '@gladysassistant/integration-sdk';
import {
  ANSWER_BUDGET,
  CONFIG_RETRY_MAX,
  CONFIG_RETRY_MIN,
  COUNT_SAVE_TIMEOUT,
  FAIL_HOLD,
  HOLD_MAX,
  HTTP_TIMEOUT,
  MAX_CACHE_ENTRIES,
  MIN_CALL_TIME,
  PAUSE_MAX_429,
  PAUSE_MAX_ERROR,
  PAUSE_MIN,
  STALE_LIMIT,
  STATE_READ_TIMEOUT,
  STATE_RETRY,
  STATE_WAIT,
  TEST_POINT,
  TEST_SPACING,
} from './constants.js';
import { normalizeConfig } from './config.js';
import { NetworkError, get } from './http.js';
import { T, en } from './i18n.js';
import { AnswerError, parseCurrent, parseWeather, queryCost, toPivot } from './pivot.js';
import { Store } from './store.js';
import { currentUrl, forecastUrl, retryAfterMs, round3 } from './visualcrossing.js';

/** An error whose text exists in English and French. */
export class TextError extends Error {
  constructor(text) {
    super(en(text));
    this.name = 'TextError';
    this.text = text;
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
const MARK = /^[0-9a-f]{2}$/;

/**
 * The mark of a refused key kept in /data: ONE byte of a salted hash. A
 * reader of /data cannot check a guess against it (1 in 256 matches).
 */
export const refusalMark = (salt, keyId) => sha(salt, keyId).slice(0, 2);
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const sha = (...parts) => createHash('sha256').update(parts.join('\n')).digest('hex');

export class VisualCrossingApp {
  constructor({
    gladys,
    logger = sdkLogger,
    now = () => Date.now(),
    monotonic = () => performance.now(),
    timers = globalThis,
    store = new Store(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.closed = false;
    this.gen = 0; // configuration generation
    this.connGen = 0; // connection generation (getConfig retries)
    this.config = normalizeConfig({});
    this.state = null; // null while /data is not read
    this.rawRead = null; // the pending read of /data (one at a time)
    this.stateWaiters = [];
    this.stateTimer = null;
    this.stateBroken = false;
    this.configTimer = null;
    this.configDelay = CONFIG_RETRY_MIN;
    this.cache = new Map();
    this.holds = new Map(); // location key -> { untilMono, untilWall, kind }
    this.inflight = new Map();
    this.chain = Promise.resolve(); // one call to Visual Crossing at a time
    this.pause = null;
    this.backoff = 0;
    this.lastTest = -Infinity;
    this.lastStatus = null;
    this.saveFailed = false;
    this.everAnswered = false;
    this.refusedId = null; // full id of the key refused in THIS process
    this.costWarned = false;
  }

  // --- lifecycle ---------------------------------------------------------------

  /** Gladys (re)connected: read the configuration, retried without end. */
  async onConnected() {
    this.cancelConfigRetry();
    const gen = ++this.connGen;
    let config;
    try {
      config = await this.gladys.getConfig();
    } catch (err) {
      if (gen !== this.connGen || this.closed) return;
      const delay = this.configDelay;
      this.configDelay = Math.min(delay * 2, CONFIG_RETRY_MAX);
      this.logger.warn(`getConfig failed (${err?.message}): new try in ${delay / 1000} s`);
      this.lastStatus = null;
      this.setStatus(false, T.configUnread(delay));
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = null;
        this.onConnected();
      }, delay);
      return;
    }
    if (gen !== this.connGen || this.closed) return;
    this.configDelay = CONFIG_RETRY_MIN;
    await this.start(config);
  }

  onDisconnected() {
    this.connGen += 1;
    this.cancelConfigRetry();
  }

  cancelConfigRetry() {
    if (this.configTimer) this.timers.clearTimeout(this.configTimer);
    this.configTimer = null;
  }

  /** (Re)start with a configuration. Pauses, refusals, counts and copies stay. */
  async start(config) {
    if (this.closed) return;
    const gen = ++this.gen;
    this.config = normalizeConfig(config);
    this.lastStatus = null;
    this.loadState();
    await this.waitState(STATE_WAIT);
    if (gen !== this.gen || this.closed) return;
    // Key changed while running: the refusal of the old one never holds the
    // new one back, whatever the byte of /data says.
    if (
      this.state?.refused &&
      this.refusedId &&
      this.config.value &&
      this.config.value.keyId !== this.refusedId
    ) {
      this.state.refused = null;
      this.refusedId = null;
      this.persist();
    }
    this.publishStatus();
  }

  async stop() {
    this.closed = true;
    this.gen += 1;
    this.connGen += 1;
    this.cancelConfigRetry();
    if (this.stateTimer) this.timers.clearTimeout(this.stateTimer);
    this.stateTimer = null;
    for (const resolve of this.stateWaiters.splice(0)) resolve();
    // The last writes, waited 2 s at most (a hung /data never blocks the exit).
    let timer;
    await Promise.race([
      this.store.flush(),
      new Promise((resolve) => {
        timer = setTimeout(resolve, 2_000);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
  }

  // --- /data -------------------------------------------------------------------

  /** Start a read of /data unless one is pending or the state is known. */
  loadState() {
    if (this.state || this.rawRead || this.closed) return;
    const read = this.store.read();
    this.rawRead = read;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve('timeout'), STATE_READ_TIMEOUT);
    });
    const settle = read.then(
      (raw) => ({ raw }),
      (err) => ({ err }),
    );
    settle.then(() => {
      if (this.rawRead === read) this.rawRead = null;
    });
    Promise.race([settle, timeout]).then((outcome) => {
      this.timers.clearTimeout(timer);
      if (this.closed || this.state) return;
      if (outcome !== 'timeout' && !outcome.err) {
        this.applyState(outcome.raw);
        this.stateBroken = false;
        for (const resolve of this.stateWaiters.splice(0)) resolve();
        return;
      }
      this.logger.warn(
        `/data/state.json not read (${outcome === 'timeout' ? 'slow' : outcome.err.message}): again in 10 s`,
      );
      this.stateBroken = true;
      this.setStatus(false, T.stateUnreadable);
      // The waiters learn now that it failed (they never wait for nothing).
      for (const resolve of this.stateWaiters.splice(0)) resolve();
      if (!this.stateTimer) {
        this.stateTimer = this.timers.setTimeout(() => {
          this.stateTimer = null;
          if (this.rawRead) {
            // The previous read still hangs: never two at a time.
            settle.then(() => this.loadState());
          } else {
            this.loadState();
          }
        }, STATE_RETRY);
      }
    });
  }

  /** Resolves when the state is known or after `ms` (bounded, never hangs). */
  waitState(ms) {
    if (this.state || this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = this.timers.setTimeout(done, ms);
      const waiters = this.stateWaiters;
      function done() {
        const i = waiters.indexOf(done);
        if (i >= 0) waiters.splice(i, 1);
        resolve();
      }
      waiters.push(() => {
        this.timers.clearTimeout(timer);
        done();
      });
    });
  }

  applyState(raw) {
    const wall = this.now();
    const mono = this.monotonic();
    const saltOk = typeof raw.salt === 'string' && /^[0-9a-f]{32}$/.test(raw.salt);
    const state = {
      salt: saltOk ? raw.salt : randomBytes(16).toString('hex'),
      day: typeof raw.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.day) ? raw.day : null,
      records: Number.isInteger(raw.records) && raw.records >= 0 ? raw.records : 0,
      refused:
        typeof raw.refused?.id === 'string' && MARK.test(raw.refused.id) ? raw.refused.id : null,
    };
    // A count dated in the future (clock jump, edited file) is kept for its
    // day: the cap stays on the safe side.
    // A pause runs on after a restart, from its wall-clock end; an end
    // further than the longest pause is invalid (clock jump, edited file).
    const p = raw.pause;
    if (p && Number.isFinite(p.untilWall) && ['429', 'error'].includes(p.kind)) {
      const left = p.untilWall - wall;
      const max = p.kind === '429' ? PAUSE_MAX_429 : PAUSE_MAX_ERROR;
      if (left > 0 && left <= max) {
        this.pause = {
          kind: p.kind,
          reason: typeof p.reason === 'string' ? p.reason.slice(0, 40) : 'error',
          untilMono: mono + left,
          untilWall: p.untilWall,
        };
        this.backoff = Number.isFinite(p.step) ? Math.min(Math.max(p.step, 0), max) : 0;
      }
    }
    // The holds of the locations whose last call failed (or was attempted
    // when the process stopped): never asked again sooner after a restart.
    for (const h of Array.isArray(raw.holds) ? raw.holds.slice(0, MAX_CACHE_ENTRIES) : []) {
      const left = h?.untilWall - wall;
      if (
        typeof h?.key !== 'string' ||
        !HEX64.test(h.key) ||
        !['400', 'fail'].includes(h.kind) ||
        !Number.isFinite(left) ||
        left <= 0 ||
        left > HOLD_MAX
      ) {
        continue;
      }
      this.holds.set(h.key, { untilMono: mono + left, untilWall: h.untilWall, kind: h.kind });
    }
    // The copies: dated by the wall clock, never from the future, never
    // older than the stale limit.
    for (const entry of Array.isArray(raw.cache) ? raw.cache.slice(0, MAX_CACHE_ENTRIES) : []) {
      const age = wall - entry?.fetchedWall;
      const s = entry?.snapshot;
      if (
        typeof entry?.key !== 'string' ||
        !HEX64.test(entry.key) ||
        !Number.isFinite(age) ||
        age < 0 ||
        age > STALE_LIMIT ||
        typeof s?.current?.asOf !== 'string' ||
        typeof s?.current?.temperature !== 'number' ||
        !Array.isArray(s.hours) ||
        !Array.isArray(s.days) ||
        !Array.isArray(s.alerts)
      ) {
        continue;
      }
      this.cache.set(entry.key, {
        snapshot: s,
        fetchedMono: mono - age,
        fetchedWall: entry.fetchedWall,
        serverDateMs: Number.isFinite(entry.serverDateMs) ? entry.serverDateMs : undefined,
        alerts: entry.alerts === true,
      });
    }
    this.state = state;
    if (!saltOk) this.persist();
  }

  /** Write the state; resolves true when written, false otherwise (logged). */
  async persist() {
    if (!this.state) return false;
    const mono = this.monotonic();
    const value = {
      version: 1,
      salt: this.state.salt,
      day: this.state.day,
      records: this.state.records,
      refused: this.state.refused ? { id: this.state.refused } : null,
      pause: this.pause
        ? {
            kind: this.pause.kind,
            reason: this.pause.reason,
            untilWall: this.pause.untilWall,
            step: this.backoff,
          }
        : null,
      holds: [...this.holds.entries()]
        .filter(([, h]) => h.untilMono > mono)
        .map(([key, h]) => ({ key, kind: h.kind, untilWall: h.untilWall })),
      cache: [...this.cache.entries()].map(([key, e]) => ({
        key,
        fetchedWall: e.fetchedWall,
        serverDateMs: e.serverDateMs,
        alerts: e.alerts,
        snapshot: e.snapshot,
      })),
    };
    try {
      await this.store.save(value);
      this.saveFailed = false;
      return true;
    } catch (err) {
      if (!this.saveFailed) this.logger.warn(`/data/state.json not written: ${err?.code ?? err}`);
      this.saveFailed = true;
      return false;
    }
  }

  /** Persist, waiting at most `ms` (a slow /data never holds a request). */
  persistWithin(ms) {
    let timer;
    return Promise.race([
      this.persist(),
      new Promise((resolve) => {
        timer = this.timers.setTimeout(() => resolve(false), ms);
      }),
    ]).finally(() => this.timers.clearTimeout(timer));
  }

  // --- status ------------------------------------------------------------------

  setStatus(connected, message) {
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus || this.closed) return;
    this.lastStatus = key;
    Promise.resolve()
      .then(() => this.gladys.setConnectionStatus(connected, message))
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err?.message}`));
  }

  publishStatus() {
    const cfg = this.config;
    if (!cfg.value) {
      this.setStatus(false, cfg.configured ? T.invalid(cfg.errors) : T.notConfigured);
      return;
    }
    if (!this.state) {
      if (this.stateBroken) this.setStatus(false, T.stateUnreadable);
      return;
    }
    const gate = this.gate(cfg, { test: false });
    if (gate) {
      this.setStatus(false, gate);
      return;
    }
    this.setStatus(true, this.everAnswered ? T.ok : T.ready);
  }

  // --- gates ---------------------------------------------------------------------

  keyMark(cfg) {
    return refusalMark(this.state.salt, cfg.value.keyId);
  }

  rollDay() {
    const day = dayKey(this.now());
    // Only forward: a wall clock set back never resets a later day's count.
    if (this.state.day === null || day > this.state.day) {
      this.state.day = day;
      this.state.records = 0;
    }
  }

  /** Why no call may leave now (a text), or null. The test ignores a refusal. */
  gate(cfg, { test }) {
    if (!test && this.state.refused && this.state.refused === this.keyMark(cfg)) {
      return T.refused;
    }
    this.rollDay();
    if (this.state.records + 1 > cfg.value.dailyBudget) return T.budget(cfg.value.dailyBudget);
    const left = this.pause ? this.pause.untilMono - this.monotonic() : 0;
    if (left > 0) {
      return this.pause.kind === '429' ? T.paused429(left) : T.pausedError(this.pause.reason, left);
    }
    return null;
  }

  setPause(kind, ms, reason) {
    const max = kind === '429' ? PAUSE_MAX_429 : PAUSE_MAX_ERROR;
    const duration = Math.min(Math.max(ms, PAUSE_MIN), max);
    this.pause = {
      kind,
      reason,
      untilMono: this.monotonic() + duration,
      untilWall: this.now() + duration,
    };
    this.persist();
  }

  /** The next doubling step: 60 s, 2 min, 4 min... up to `max`. */
  nextBackoff(max) {
    this.backoff = this.backoff ? Math.min(this.backoff * 2, max) : PAUSE_MIN;
    return this.backoff;
  }

  setHold(key, kind, ms) {
    this.holds.delete(key);
    this.holds.set(key, {
      kind,
      untilMono: this.monotonic() + ms,
      untilWall: this.now() + ms,
    });
    while (this.holds.size > MAX_CACHE_ENTRIES) {
      this.holds.delete(this.holds.keys().next().value);
    }
  }

  /** One call at a time to Visual Crossing (the account allows few at once). */
  exclusive(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  /**
   * One call to Visual Crossing, counted on disk before it leaves, never
   * retried (it may have been billed). `holdKey` names the location: held
   * FAIL_HOLD from before the call, lifted by a success.
   */
  call(build, cfg, gen, { test = false, deadline = Infinity, holdKey } = {}) {
    return this.exclusive(async () => {
      if (this.closed) throw new TextError(T.noTime);
      const gate = this.gate(cfg, { test });
      if (gate) throw new TextError(gate);
      // Gladys waits 15 s: a call that cannot end in time does not leave.
      if (deadline - this.monotonic() < MIN_CALL_TIME) throw new TextError(T.noTime);
      this.state.records += 1;
      if (holdKey) this.setHold(holdKey, 'fail', FAIL_HOLD);
      // Nothing leaves: the hold goes (the count stays, on the safe side).
      const notSent = (text) => {
        if (holdKey) this.holds.delete(holdKey);
        return new TextError(text);
      };
      if (!(await this.persistWithin(COUNT_SAVE_TIMEOUT))) throw notSent(T.notCounted);
      if (deadline - this.monotonic() < MIN_CALL_TIME) throw notSent(T.noTime);
      let res;
      try {
        res = await get(build(cfg.value.apiKey), {
          timeout: Math.min(HTTP_TIMEOUT, Math.max(1, deadline - this.monotonic())),
        });
      } catch (err) {
        const reason = err instanceof NetworkError ? err.message : 'no answer';
        this.setPause('error', this.nextBackoff(PAUSE_MAX_ERROR), reason);
        if (gen === this.gen) this.publishStatus();
        throw new TextError(T.pausedError(reason, this.backoff));
      }
      if (res.status === 200) {
        // The real cost of the call (1 for a forecast) on top of the 1
        // already counted.
        const cost = queryCost(res.text) ?? 1;
        if (cost > 1) {
          this.state.records += cost - 1;
          if (!this.costWarned) {
            this.logger.warn(`A Visual Crossing call cost ${cost} records`);
            this.costWarned = true;
          }
        }
        this.backoff = 0;
        this.pause = null;
        const mark = this.keyMark(cfg);
        if (this.state.refused === mark) {
          this.state.refused = null;
          this.refusedId = null;
        }
        if (holdKey) this.holds.delete(holdKey);
        this.persist();
        return { ...res, cost };
      }
      if (res.status === 401) {
        // The refusal holds every location; a new key must not find this one held.
        if (holdKey) this.holds.delete(holdKey);
        this.state.refused = this.keyMark(cfg);
        this.refusedId = cfg.value.keyId;
        this.persist();
        this.logger.warn('Visual Crossing refused the API key (HTTP 401)');
        if (gen === this.gen) this.publishStatus();
        throw new TextError(T.refused);
      }
      if (res.status === 429) {
        const asked = retryAfterMs(res.retryAfter, res.date);
        const ms = asked ?? this.nextBackoff(PAUSE_MAX_429);
        this.setPause('429', ms, 'HTTP 429');
        if (gen === this.gen) this.publishStatus();
        throw new TextError(T.paused429(this.pause.untilMono - this.monotonic()));
      }
      const reason = `HTTP ${res.status}`;
      if (res.status === 400 || res.status === 404) {
        // This location is not served. No global pause: it is held back for
        // one refresh interval.
        if (holdKey) {
          this.setHold(holdKey, '400', cfg.value.refreshMs);
          this.persist();
        }
        throw new TextError(T.notServed(reason));
      }
      // 403 (a proxy or a firewall in front of the API), 5xx, others: a
      // pause, never a refusal of the key.
      this.setPause('error', this.nextBackoff(PAUSE_MAX_ERROR), reason);
      if (gen === this.gen) this.publishStatus();
      throw new TextError(T.pausedError(reason, this.backoff));
    });
  }

  // --- the weather -------------------------------------------------------------

  async ensureReady() {
    const cfg = this.config;
    if (!cfg.value) throw new TextError(cfg.configured ? T.invalid(cfg.errors) : T.notConfigured);
    if (!this.state) {
      this.loadState();
      await this.waitState(STATE_WAIT);
      if (!this.state) throw new TextError(T.stateUnreadable);
    }
    return cfg;
  }

  /** onWeatherGet: answered from the copy, or after one call (under 15 s). */
  async getWeather({ latitude, longitude, units } = {}) {
    const started = this.monotonic();
    const cfg = await this.ensureReady();
    if (
      typeof latitude !== 'number' ||
      typeof longitude !== 'number' ||
      !(Math.abs(latitude) <= 90) ||
      !(Math.abs(longitude) <= 180)
    ) {
      throw new TextError(T.badLocation);
    }
    const deadline = started + ANSWER_BUDGET;
    const point = { latitude: round3(latitude), longitude: round3(longitude) };
    const { alerts } = cfg.value;
    const key = sha(this.state.salt, point.latitude, point.longitude, alerts);
    const entry = this.cache.get(key);
    const mono = this.monotonic();
    if (entry && mono - entry.fetchedMono < cfg.value.refreshMs) return this.answer(entry, units);
    let pending = this.inflight.get(key);
    if (!pending) {
      const held = this.holds.get(key);
      if (held !== undefined && mono < held.untilMono) {
        if (entry && mono - entry.fetchedMono <= STALE_LIMIT) return this.answer(entry, units);
        throw new TextError(
          held.kind === '400' ? T.notServed('HTTP 400') : T.held(held.untilMono - mono),
        );
      }
      pending = this.fetchWeather(key, { ...point, alerts }, cfg, deadline);
      this.inflight.set(key, pending);
      pending.finally(() => this.inflight.delete(key)).catch(() => {});
    }
    let fresh;
    try {
      fresh = await pending;
    } catch (err) {
      // Visual Crossing unavailable: the last copy, if under the stale limit,
      // with its own date (never presented as new); else the error, and
      // Gladys falls back to its next provider.
      const kept = this.cache.get(key);
      if (kept && this.monotonic() - kept.fetchedMono <= STALE_LIMIT)
        return this.answer(kept, units);
      throw err;
    }
    return this.answer(fresh, units);
  }

  async fetchWeather(key, params, cfg, deadline) {
    const gen = this.gen;
    const res = await this.call((apiKey) => forecastUrl({ ...params, key: apiKey }), cfg, gen, {
      deadline,
      holdKey: key,
    });
    let snapshot;
    try {
      snapshot = parseWeather(res.text);
    } catch (err) {
      if (!(err instanceof AnswerError)) throw err;
      this.setHold(key, 'fail', FAIL_HOLD);
      this.setPause('error', this.nextBackoff(PAUSE_MAX_ERROR), err.message);
      if (gen === this.gen) this.publishStatus();
      throw new TextError(T.pausedError(err.message, this.backoff));
    }
    const serverDateMs = Date.parse(res.date ?? '');
    const entry = {
      snapshot,
      fetchedMono: this.monotonic(),
      fetchedWall: this.now(),
      serverDateMs: Number.isFinite(serverDateMs) ? serverDateMs : undefined,
      alerts: params.alerts,
    };
    this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      this.cache.delete(this.cache.keys().next().value);
    }
    this.persist();
    this.everAnswered = true;
    if (gen === this.gen) this.publishStatus();
    return entry;
  }

  answer(entry, units) {
    const elapsed = this.monotonic() - entry.fetchedMono;
    return toPivot(entry.snapshot, {
      units: units === 'us' ? 'us' : 'metric',
      nowMs: this.now(),
      serverNowMs: entry.serverDateMs === undefined ? undefined : entry.serverDateMs + elapsed,
      alerts: entry.alerts,
    });
  }

  // --- the test button -----------------------------------------------------------

  /** One call (current conditions at a fixed point); a success lifts a refusal. */
  async testConnection() {
    let cfg;
    try {
      cfg = await this.ensureReady();
    } catch (err) {
      return err.text ?? { en: err.message, fr: err.message };
    }
    const since = this.monotonic() - this.lastTest;
    if (since < TEST_SPACING) return T.testWait(TEST_SPACING - since);
    const gate = this.gate(cfg, { test: true });
    if (gate) return gate;
    this.lastTest = this.monotonic();
    const gen = this.gen;
    try {
      const res = await this.call(
        (apiKey) => currentUrl({ ...TEST_POINT, key: apiKey }),
        cfg,
        gen,
        {
          test: true,
          deadline: this.monotonic() + 25_000,
        },
      );
      try {
        parseCurrent(res.text);
      } catch (err) {
        if (!(err instanceof AnswerError)) throw err;
        return T.unreadable(err.message);
      }
      if (gen === this.gen) {
        this.lastStatus = null;
        this.publishStatus();
      }
      return T.testOk({
        cost: res.cost,
        records: this.state.records,
        budget: cfg.value.dailyBudget,
      });
    } catch (err) {
      return err.text ?? { en: err.message, fr: err.message };
    }
  }
}

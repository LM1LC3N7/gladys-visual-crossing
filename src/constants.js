// -----------------------------------------------------------------------------
// Endpoints, pacing and limits. Every delay is in milliseconds.
// -----------------------------------------------------------------------------

export const VERSION = '0.1.0';
export const REPO_URL = 'https://github.com/LM1LC3N7/gladys-visual-crossing';
export const USER_AGENT = `gladys-visual-crossing/${VERSION} (+${REPO_URL})`;

export const API_BASE =
  'https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline';

// One forecast (current + 15 days of 24 hours + alerts, only the elements
// used) is about 150 KB: 1 MB is a generous cap, cut before the whole body.
export const MAX_BODY_BYTES = 1_000_000;
// Gladys waits 15 s for the weather: one request fits, never a retry.
export const HTTP_TIMEOUT = 10_000;
// Everything of one weather request (waiting for /data, for the call of
// another location, the call itself) ends within this, under the 15 s.
export const ANSWER_BUDGET = 13_000;
// A call with less time than this left does not leave.
export const MIN_CALL_TIME = 2_000;
// The count of the call must be on disk within this, or nothing leaves.
export const COUNT_SAVE_TIMEOUT = 1_000;

// Pacing per location: never read faster than this (minutes, user option).
// Visual Crossing updates its forecasts about once an hour.
export const REFRESH_DEFAULT_MIN = 60;
export const REFRESH_MIN_MIN = 60;
export const REFRESH_MAX_MIN = 180;
// After a failed call, this location is not asked again before this.
export const FAIL_HOLD = 15 * 60_000;
// The longest hold of a location (a 400: one refresh interval at most).
export const HOLD_MAX = REFRESH_MAX_MIN * 60_000;
// A copy older than this is never served, even when Visual Crossing is down.
export const STALE_LIMIT = 4 * 3600_000;

// Daily cap of records counted here (UTC day). The free plan gives 1,000 a
// day; a forecast costs 1 record (the `queryCost` of the answer is counted).
export const BUDGET_DEFAULT = 500;
export const BUDGET_MIN = 10;
export const BUDGET_MAX = 100_000;
// A cost above this in one answer is not believed (counted as this).
export const MAX_QUERY_COST = 10_000;

// Pauses after an error: 429 follows Retry-After within 60 s - 6 h, the
// others double from 60 s up to 1 h.
export const PAUSE_MIN = 60_000;
export const PAUSE_MAX_429 = 6 * 3600_000;
export const PAUSE_MAX_ERROR = 3600_000;

// /data: read within 2 s, else re-read every 10 s (one read at a time).
export const STATE_READ_TIMEOUT = 2_000;
export const STATE_RETRY = 10_000;
// A weather request waits at most this long for /data.
export const STATE_WAIT = 2_000;
// getConfig() failing: retried from 5 s, doubling, up to 5 minutes.
export const CONFIG_RETRY_MIN = 5_000;
export const CONFIG_RETRY_MAX = 5 * 60_000;
// The test button: one call per minute at most.
export const TEST_SPACING = 60_000;

// At most this many locations kept (memory and /data).
export const MAX_CACHE_ENTRIES = 8;
// Gladys keeps 24 hours and 8 days.
export const MAX_HOURS = 24;
export const MAX_DAYS = 8;
export const MAX_ALERTS = 10;

// The test button asks the current conditions here (Greenwich observatory:
// no personal data, no `location` permission needed).
export const TEST_POINT = { latitude: 51.477, longitude: 0 };

export const ACTIONS = { TEST: 'test_connection' };

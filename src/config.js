// -----------------------------------------------------------------------------
// The configuration screen, normalized. An invalid field is named, its value
// never repeated (the API key above all).
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import {
  BUDGET_DEFAULT,
  BUDGET_MAX,
  BUDGET_MIN,
  REFRESH_DEFAULT_MIN,
  REFRESH_MAX_MIN,
  REFRESH_MIN_MIN,
} from './constants.js';

// A Visual Crossing key is 25 letters and digits; a little slack is left,
// but never a space, a control byte or a URL character.
const KEY = /^[A-Za-z0-9]{16,64}$/;

function integer(value, { min, max, fallback }) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined;
  if (n < min || n > max) return undefined;
  return n;
}

/**
 * Returns `{ configured, errors, value }`. `configured` is false while the key
 * is empty (fresh install); `errors` lists the invalid keys.
 */
export function normalizeConfig(raw = {}) {
  const config = raw && typeof raw === 'object' ? raw : {};
  const errors = [];
  const apiKey = typeof config.api_key === 'string' ? config.api_key.trim() : '';
  const configured = apiKey !== '';
  if (!KEY.test(apiKey)) errors.push('api_key');

  const alerts = config.alerts === undefined || config.alerts === null ? true : config.alerts;
  if (typeof alerts !== 'boolean') errors.push('alerts');

  const refreshMinutes = integer(config.refresh_minutes, {
    min: REFRESH_MIN_MIN,
    max: REFRESH_MAX_MIN,
    fallback: REFRESH_DEFAULT_MIN,
  });
  if (refreshMinutes === undefined) errors.push('refresh_minutes');
  const dailyBudget = integer(config.daily_budget, {
    min: BUDGET_MIN,
    max: BUDGET_MAX,
    fallback: BUDGET_DEFAULT,
  });
  if (dailyBudget === undefined) errors.push('daily_budget');

  if (errors.length > 0) return { configured, errors, value: null };
  return {
    configured,
    errors,
    value: {
      apiKey,
      // Identifies the key (salted again in app.js): a refused key is never
      // sent again on its own, a new one always is.
      keyId: createHash('sha256').update(`visual-crossing\n${apiKey}`).digest('hex'),
      alerts,
      refreshMs: refreshMinutes * 60_000,
      dailyBudget,
    },
  };
}

// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ACTIONS,
  BUDGET_DEFAULT,
  BUDGET_MAX,
  BUDGET_MIN,
  REFRESH_DEFAULT_MIN,
  REFRESH_MAX_MIN,
  REFRESH_MIN_MIN,
  VERSION,
} from '../src/constants.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const index = read('index.js');
const dockerfile = read('Dockerfile');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

test('the store basics', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'weather');
  assert.ok(!('location' in manifest)); // the coordinates come with each request
  assert.equal(
    manifest.docker_image,
    `ghcr.io/lm1lc3n7/gladys-visual-crossing:${manifest.version}`,
  );
  assert.deepEqual(manifest.categories, ['environment']);
  assert.deepEqual(manifest.transports, ['cloud']);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(manifest.description.en, /Unofficial/);
  assert.match(manifest.description.fr, /Non officiel/);
});

test('versions: semver, the same four, never pinned; the store fields', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(VERSION, pkg.version);
  assert.equal(lock.name, pkg.name);
  assert.equal(manifest.gladys_version, '>=5.1.0');
  assert.ok(!('keywords' in manifest) && !('countries' in manifest));
  assert.match(pkg.dependencies['@gladysassistant/integration-sdk'], /^\^0\.16\./);
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
});

test('the docs say it was never tested with a real account; costs and attribution', () => {
  assert.match(read('docs/fr.md'), /[Jj]amais\s+(été\s+)?testée?\s+avec\s+un\s+vrai\s+compte/);
  assert.match(read('docs/en.md'), /[Nn]ever\s+tested\s+with\s+a\s+real\s+account/);
  assert.match(read('README.md'), /[Nn]ever\s+tested\s+with\s+a\s+real\s+account/);
  for (const file of ['docs/fr.md', 'docs/en.md', 'README.md']) {
    assert.match(read(file), /1[ ,\u202f]000/, file); // the free records per day
    assert.match(read(file), /0[.,]0001/, file); // the pay-as-you-go price
    assert.match(read(file), /Visual Crossing/, file);
  }
  assert.match(read('docs/en.md'), /Weather data provided by Visual Crossing/);
  assert.match(read('docs/fr.md'), /Données météo fournies par Visual Crossing/);
});

test('every text is in English and French; placeholders too', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
  }
  for (const field of manifest.config_schema) {
    if ('placeholder' in field) assert.equal(typeof field.placeholder, 'object', field.key);
  }
});

test('the configuration matches the code; the secret has no default', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  assert.deepEqual(Object.keys(fields), [
    'intro',
    'api_key',
    'alerts',
    'refresh_minutes',
    'daily_budget',
  ]);
  for (const field of manifest.config_schema) {
    assert.ok(!field.key.startsWith('gladys_'), field.key);
    assert.ok(!(field.type === 'secret' && 'default' in field), field.key);
  }
  assert.equal(fields.api_key.type, 'secret');
  assert.match(fields.api_key.description.en, /Kept by Gladys in its database, never shown again/);
  assert.match(fields.api_key.description.fr, /Gardée par Gladys dans sa base, jamais réaffichée/);
  assert.equal(fields.refresh_minutes.default, REFRESH_DEFAULT_MIN);
  assert.equal(fields.refresh_minutes.min, REFRESH_MIN_MIN);
  assert.equal(fields.refresh_minutes.max, REFRESH_MAX_MIN);
  assert.equal(fields.daily_budget.default, BUDGET_DEFAULT);
  assert.equal(fields.daily_budget.min, BUDGET_MIN);
  assert.equal(fields.daily_budget.max, BUDGET_MAX);
  assert.equal(fields.alerts.default, true);
  for (const link of fields.intro.links) assert.match(link.url, /^https:\/\//);
});

test('no device, so no supported_options; every select option is well formed', () => {
  assert.doesNotMatch(JSON.stringify(manifest), /supported_options/);
  for (const file of ['index.js', 'src/app.js']) {
    assert.doesNotMatch(read(file), /publishDiscoveredDevices|publishState/, file);
  }
  for (const field of manifest.config_schema.filter((f) => Array.isArray(f.options))) {
    const values = field.options.map((o) => o.value);
    assert.equal(new Set(values).size, values.length, field.key);
    for (const option of field.options) {
      assert.deepEqual(Object.keys(option).sort(), ['label', 'value']);
      for (const text of Object.values(option.label)) {
        assert.equal(typeof text, 'string');
        assert.equal(text, text.trim());
        assert.ok(text.length > 0);
      }
    }
  }
});

test('the actions of the manifest are the handlers of the code', () => {
  assert.deepEqual(
    manifest.actions.map((a) => a.key),
    Object.values(ACTIONS),
  );
  assert.ok(index.includes('onAction(ACTIONS.TEST'));
  assert.ok(index.includes('onWeatherGet('));
  assert.ok(index.includes("on('connected'"));
});

test('the licenses ship in the image; no name in LICENSE', () => {
  assert.match(dockerfile, /COPY LICENSE THIRD_PARTY_NOTICES\.md/);
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
  assert.match(read('THIRD_PARTY_NOTICES.md'), /Visual Crossing/);
});

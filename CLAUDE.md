# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors.

## What this is

A Gladys Assistant **external integration** of type `weather`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.16). It
answers `onWeatherGet` with the pivot weather format, from the **Visual
Crossing Timeline Weather API**, with the user's own API key (a billable
account: records counted before each call). Unofficial: not affiliated with
Visual Crossing. No devices, no states.

## Commands

```bash
npm install
npm test                 # node --test --test-timeout=60000
npm run lint
npm run format:check
npm run audit            # npm audit --omit=dev
node scripts/mutants.mjs # mutants of scripts/mutants.json, one at a time (use memcap)
```

## Architecture

```
index.js            SDK wiring only (handlers registered before connect())
src/app.js          VisualCrossingApp: copies per location, holds, pacing,
                    daily cap, one call at a time, pauses, refusal, /data,
                    status, test button
src/config.js       config_schema normalized (invalid fields named, never echoed)
src/visualcrossing.js  URLs, Retry-After (pure)
src/pivot.js        answer -> trimmed snapshot -> pivot weather, units, queryCost (pure)
src/conditions.js   icons, precipitation types, alert levels and phenomena (pure)
src/store.js        /data/state.json: read (missing = empty, unreadable = error),
                    one write queue, atomic rename
src/http.js         the only network access: timeout, no redirect, 1 MB cap
src/i18n.js         runtime texts (en/fr)
test/helpers/       clock that advances, fake fetch, memory /data, an answer
```

## Rules

- The API key never reaches a log, a status, an error or `/data` (it travels
  in the query string: the URL is never logged nor put in an error).
- Decisions (copy age, holds, pauses, test spacing) use the injected
  `monotonic` clock; the wall clock only names the UTC day, dates `/data` and
  drops past hours.
- Every call is counted in `/data` before it leaves (written, or nothing
  leaves); its location is held 15 min from before the call; a call that may
  have been billed is never retried; the `queryCost` of the answer is added.
- One call at a time (the `exclusive` chain).
- A 401 is a refusal at once; `/data` keeps one byte of a salted hash of the
  key; a key changed while running is always tried. A 403 pauses.
- 400/404 hold back their location only, for one interval; no global pause.
- A weather request ends within 13 s (no call leaves with less than 2 s).
- An unknown value stays out of the answer, never 0.
- Unit tests for every change; `npm run format:check`, `lint`, `test` before
  a commit. Update `docs/`, `README.md`, `TODO.md` and `CHANGELOG.md` with it.

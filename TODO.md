# TODO

## Decisions

- Version 0.1.0 set by hand (package.json, lock, manifest, `docker_image`).
- SDK `^0.16.0` (latest on npm on 2026-11-15). Manifest: `gladys_version`
  `>=5.1.0`, category `environment` only, no `keywords`, no `countries`
  (Visual Crossing covers the world), no `location` (the coordinates come
  with each weather request; the test button reads a fixed point, Greenwich).
- Written from the official Timeline Weather API documentation only (no
  reference client): nothing to license beyond the SDK.
- Billing: the forecast endpoint without dates (`/timeline/lat,lon`), cost 1
  record per the documentation; never a date range (a past day is billed per
  record). The `queryCost` of each answer is counted on top of the 1 counted
  before the call. Daily cap (UTC day) 500 by default, 10 - 100,000; the count
  must be on disk (1 s) before a call leaves, else nothing is sent. A day
  count from a later day (clock set back) is never reset.
- No retry of a call that may have been billed: timeout, network error, 5xx,
  unreadable answer: the location is held 15 min (written to /data BEFORE the
  call, so a restart mid-call does not repeat it) plus a global pause 60 s
  doubled up to 1 h. 429: Retry-After against the server Date, else 60 s
  doubled, 60 s - 6 h.
- One call at a time for the whole integration (Visual Crossing limits
  concurrent jobs per account).
- Refresh 60 - 180 min (Visual Crossing updates about hourly; "one read per
  hour at most" from the lot proposal). A copy is served up to 4 h old during
  an outage, with its own date.
- HTTP 401 = refused key at once (no second try: it could be billed); 403 is a
  pause (proxy, firewall), never a refusal. The refusal is one byte of a
  salted hash in `/data`; a new key is always tried; the test button lifts it.
- 400/404: this location held one refresh interval, no global pause.
- Always the metric unit group, converted here for US users: one call per
  location serves every user. No `lang` sent (the icons are mapped, the alert
  texts come as Visual Crossing gives them).
- Conditions from the `icons2` set + `preciptype` + the hourly `precip`
  (pouring from 7.6 mm/h); day/night from the sun epochs, else the icon.
- Alert level guessed from the title (no level in the API): red/extreme,
  yellow/moderate/watch, orange/severe/warning, else minor ("Red Flag" is not
  red).
- `elements` restricts the answer to the fields used (smaller, same cost).

## Before announcing

- [ ] Test with a real Visual Crossing key on a real Gladys 5.3: the weather
      widget (current, hours, days, alerts), the assistant, the weather-alert
      scene trigger, the test button; check `queryCost` is 1 for the forecast
      and for the test.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store.

## To confirm with a real account

- [ ] The `elements` list keeps `currentConditions` and `alerts` whole (alert
      fields `event`, `headline`, `description`, `onsetEpoch`, `endsEpoch`).
- [ ] Whether Visual Crossing sends `Retry-After` with its 429.
- [ ] The attribution Visual Crossing asks for in its terms (the docs and the
      configuration screen say "Weather data provided by Visual Crossing").
- [ ] The UTC day matches the reset of the free 1,000 records.

## From review r1 (low stakes, left for later)

- A hold read from `/data` up to 3 h is accepted (HOLD_MAX = the longest
  refresh); could be bounded by its kind (15 min for a failure).
- The lifting of a refusal by a new key is written without a test of the
  write itself.
- The end of an alert is judged on the server Date + the local monotonic time
  since the answer; a copy restored from `/data` keeps the old server Date
  (no alert ever called ended too early, some kept a little longer).
- No test at the exact UTC midnight boundary of the day count.
- The refusal mark is salted per installation but the salt sits in `/data`
  beside it (one byte: 1 guess in 256 matches, by design).
- A copy older than 4 h is never served on the normal path; during a hold the
  same limit applies (one test only).

## Ideas

- Air quality (`elements=add:aqius`), at a possible extra cost: to check.
- The language of the alert texts (`lang`), if Visual Crossing translates them.
- [ ] r2 mineurs : tests de la coupe des copies (30 h, 9 jours ; N7, N8), message 5xx + Retry-After (N14), docs/fr.md:111-112 : mots-clés d'alerte lus en anglais seulement (ne pas les traduire).

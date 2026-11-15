# gladys-visual-crossing

**Unofficial** [Gladys Assistant](https://gladysassistant.com) external integration: makes
[Visual Crossing](https://www.visualcrossing.com/) the weather provider of Gladys (manifest type `weather`):
current conditions, 24 hours, 8 days and the active alerts, in metric or US units, with your own Visual Crossing
API key. Not affiliated with Visual Crossing Corporation.

> **Never tested with a real account**: written from the official documentation of the Timeline Weather API.

- **Costs**: the free plan includes 1,000 records a day and a forecast costs 1 record. On the pay-as-you-go plan the
  records beyond the free ones are billed by Visual Crossing (0.0001 USD each at the time of writing). The
  integration counts each call **before** it leaves, keeps the count in `/data`, stops at a daily cap (500 by
  default) and never retries a call that may have been billed.
- Each location is read at most once per refresh interval (60 minutes by default, 60 to 180); one call at a time.
- The API key never reaches a log, a status, an error or `/data`; an HTTP 401 stops its use until a new key is
  saved or the test button succeeds.

User guide: [English](docs/en.md) · [Français](docs/fr.md). Weather data provided by Visual Crossing.

## Development

```bash
npm install
npm test
npm run lint
npm run format:check
```

Project rules: [CLAUDE.md](CLAUDE.md). License: Apache-2.0 ([LICENSE](LICENSE)).

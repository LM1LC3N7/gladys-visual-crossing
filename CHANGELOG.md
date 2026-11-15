# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-11-15

### Added

- Visual Crossing as the weather provider of Gladys: current conditions, 24
  hours, 8 days and the active alerts, in metric or US units, with the user's
  own API key.
- One copy per location, read at most once per refresh interval (60 minutes
  by default), one call at a time, a daily cap of records counted before each
  call, no retry of a call that may have been billed, pauses after 429 and
  errors, all kept in `/data` across restarts.
- A Retry-After on a 5xx is followed (60 s - 1 h); the doubling step of the
  pauses survives a restart.
- A key refused (HTTP 401) is no longer sent; "Test Visual Crossing" checks
  it and lifts the refusal.

[Unreleased]: https://github.com/LM1LC3N7/gladys-visual-crossing/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-visual-crossing/releases/tag/v0.1.1

# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-09-26

### Added

- `./ledger`: synchronous SQLite single-use claims with expiry checked before purge, SHA-256 code IDs in two schemes, ledger identity validation and a Durable Object base.
- `./http`: `fetchBounded` with one overall deadline, a streamed body-byte limit, URL redaction in errors, and retries honoring `Retry-After` for safe requests only. A mutation combined with retries throws.
- `./results`: bounded tool-result envelopes with cursors, `withinBudget` and `assertWithinBudget` for hand-built results, `clampPage` and `boundedInt`.
- `./annotations`: behavior presets and a `registerTool` helper that refuses unannotated tools.
- `./conformance`: language-neutral JSON fixtures for the ledger algorithm and a TypeScript runner.

[0.1.0]: https://github.com/aunysillyme-dev/mcp-core/releases/tag/v0.1.0

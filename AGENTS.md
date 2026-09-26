# AGENTS.md

Guidance for coding agents working in this repository.

## Build and test

- `npm install` (runs `prepare`, which builds `dist/` with TypeScript)
- `npm test` runs every suite; `npm run conformance` runs the shared ledger fixtures.
- Node.js 22.13 or later. There are no runtime dependencies; keep it that way.

## Rules for changes

- Every behavior change ships with a test that fails without it. Show it failing first.
- `consumeCode` must stay synchronous: no `await` between the expiry check, purge and insert.
- `fetchBounded` must never retry a request marked `safe: false`.
- Result constructors must stay within their budget; hand-built results go through `withinBudget`.
- Server-specific values (signing domains, secret names, TTLs, redirect allowlists, Durable Object names) are passed in by the consumer. Never hardcode them here.
- Update `CHANGELOG.md` and bump the version in `package.json` for every release; consumers pin tags.

## Layout

- `src/` TypeScript sources, one file per export.
- `src/conformance/` JSON fixtures shared with non-TypeScript implementations.
- `test/` Node test runner suites.

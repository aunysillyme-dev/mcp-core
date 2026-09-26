# @auny/mcp-core

Small TypeScript primitives for MCP servers on Cloudflare Workers. They share
single-use code consumption, bounded HTTP reads, tool results and annotations
without moving server policy into a library. MIT licensed, with zero runtime
dependencies.

## Install

```sh
npm install 'git+https://github.com/auny-ai/mcp-core.git#v0.1.0'
```

Git installs run `prepare` to build JavaScript and declarations from source.
Development requires Node.js 22.13 or later. The only development dependencies
are TypeScript and Cloudflare Workers types. There are no SDK or schema-library
peers in this version.

`dist/` is ignored in Git and included in the installable package. Building it
from the pinned source during `prepare` avoids stale checked-in output and keeps
consumers from compiling this package's source under their own TypeScript settings.

## Modules

| Import | Purpose and boundary |
| --- | --- |
| `@auny/mcp-core/ledger` | Synchronous SQLite single-use claims, SHA-256 code IDs, identity validation and a Durable Object mixin. The Worker condition also exports a `CodeLedger` base; signatures remain the server's responsibility. |
| `@auny/mcp-core/http` | `fetchBounded` applies one deadline, a body-byte limit and optional safe-request retries. Mutations must pass `safe: false`; combining that with retries throws synchronously. |
| `@auny/mcp-core/results` | `ok`, `okText`, `fail`, `absent`, `partial` and `run` format bounded tool results; `clampPage` supplies page cursors. `boundedInt` currently provides a dependency-free validator and JSON Schema, not a Zod schema. |
| `@auny/mcp-core/annotations` | Immutable read, write, destructive, idempotent and open-world presets describe tool behavior. `registerTool` requires valid annotations before calling the server registration method. |
| `@auny/mcp-core/conformance` | JSON fixtures and runners pin SQLite consume behavior and both supported code-ID derivations. Other languages can copy the JSON files and run the same cases with their own SQLite adapter. |

This release has no OAuth route or Google account module.

## Ledger integration

The portable entry point does not import `cloudflare:workers`, so its pure core
and fixtures run in Node. Keep your existing exported Durable Object class name,
binding, object name and migration history when adopting the mixin:

```ts
import { DurableObject } from 'cloudflare:workers';
import { makeCodeLedger, claimAuthCode } from '@auny/mcp-core/ledger';

export class CodeLedger extends makeCodeLedger(DurableObject) {}
// After signature and expiry verification in your request handler:
// const claimed = await claimAuthCode(env.CODE_LEDGER, code, expiresAt);
```

When the bundler resolves the `workerd` export condition, it also exposes
`CodeLedger<Env>` as a ready-made base. For TypeScript direct-base imports, enable
`customConditions: ["workerd"]` and the Worker's platform type declarations.
The mixin works without conditional resolution. Override the base's protected
`codeIdPattern` or pass a pattern to `makeCodeLedger` / `consumeCode` only when
preserving an existing code-ID contract.

`consumeCode(sql, codeId, expiresAt, now, pattern?)` uses millisecond timestamps
and accepts `now === expiresAt`, preserving the source algorithm. It refuses
expired input before executing any SQL, then purges old rows and uses
`INSERT OR IGNORE` followed by SQLite `changes()`. It contains no `await`.

`claimAuthCode` hashes the complete code, selects the `authorization-codes`
object, and accepts only the literal boolean `true`. Missing bindings and RPC
failures raise `CodeLedgerUnavailableError`. Callers must fail closed.
For a different object name, adapt the namespace before passing it in.

### Storage identity and reset protection

`LEDGER_IDENTITY` records `class`, `objectName`, `codeIdScheme` and `signingDomain`.
Call `validateLedgerIdentity(current, previousDeployedIdentity)` during deployment
validation. Changing the first three fields requires changing the signing domain.
The signing domain must also be unique to each server.

A fresh ledger alone cannot reject an already redeemed, still-valid signed code.
Verify signatures with the new domain **before** calling the replacement ledger.
The validator compares declarations; it cannot detect storage erased behind an
unchanged identity, prove global domain uniqueness or reject a reused historic
domain. Preserve identity history and check uniqueness in the adopting fleet.

Both `sha256-b64url-43` and the legacy `sha256-b64url-32` are supported. The latter
means the first 32 characters of a SHA-256 base64url digest; its consume pattern
retains historical length-only validation. Legacy adapters may hash a signature
rather than the entire code and may use another time unit. The fixture inputs
explicitly describe what is hashed; adapters must preserve their own derivation
and supply consistent timestamps. This release does not migrate either scheme.

## HTTP policy

```ts
import { fetchBounded } from '@auny/mcp-core/http';

const response = await fetchBounded('https://example.com/items', {}, {
  deadlineMs: 5000, maxBodyBytes: 65536, safe: true, retries: 2,
});
```

The deadline includes attempts, backoff and body reading. Retries default to zero.
Safe requests retry network failures, HTTP 429 and 5xx responses, with exponential
backoff starting at 100 ms and capped at 5 seconds. A valid `Retry-After` overrides
backoff unless `honorRetryAfter: false`. Mutations ignore `Retry-After`.
`retryOn` customizes status selection; setting `safe: true` is the caller's explicit
assertion that replay is acceptable, regardless of the HTTP method.

Body text is strict UTF-8. Truncation cancels the stream and drops incomplete final
code points. A truncated JSON response is not guaranteed to parse. Body-read
failures do not cause retries. Streaming `init.body` cannot be retried.
Errors remove URL credentials, query and fragment and do not expose upstream
exception text or causes. Paths remain visible, so do not put secrets in paths.

## Results and cursors

The budget binds results built by `ok`, `okText`, `fail`, `partial` and `run`. A result you assemble by hand (for example, several content parts) is not measured unless you pass it through `withinBudget(result, budget)` or `assertWithinBudget(result, budget)`.

`Budget.maxBytes` counts UTF-8 bytes of the **entire serialized result**, including
both text and structured content. `DEFAULT_BUDGET` is provisionally 32768 bytes;
representative response measurements must set its production value.

`ok` snapshots JSON data and wraps it in `{ data }`. Oversized arrays truncate at
record boundaries, objects at top-level property boundaries, and strings at
Unicode code-point boundaries. Truncated results carry `truncated: true` and a
cursor in both text JSON and structured content. `okText` keeps complete text
plain, but uses a JSON text/cursor envelope when truncated.

Cursors describe offsets in the same immutable input, not upstream pagination
tokens: `offset:N` for array records, `property:N` for ordered object entries,
`scalar:N` for a string passed to `ok`, and `text:N` / `error:N` for text or errors.
Resume by applying the offset to the original input; offset cursors produced from
an already sliced page are relative to that page. The caller owns persistence and
upstream cursor translation. `clampPage` uses a supplied last-included-row cursor
for APIs with exclusive after-cursor pagination.

Impossible budgets and a first record too large to fit throw instead of returning
a non-progressing cursor. `partial` preserves resource IDs and the complete
resume instruction, or throws if they exceed the default budget. `run` converts
operation/formatting failures into `isError: true` results when the budget can
hold one. Non-JSON data, cycles and values that JSON would silently omit are
rejected. `fail` and `absent` always set `isError: true`; URL redaction is on by
default for failures.

`boundedInt(min, max, defaultValue)` offers `parse`, `safeParse` and `jsonSchema`,
with no coercion. It is **not accepted directly as a Zod schema** by SDK APIs
requiring Zod. Such consumers must build their own Zod schema with the same
bounds. A Zod factory is deferred until a runtime peer is permitted.

## Annotations

Use `READ_ONLY`, `IDEMPOTENT_WRITE`, `WRITE`, `DESTRUCTIVE`, `SPENDS_MONEY` and
`OPEN_WORLD`. Combine the last preset with another using object spread.
`registerTool(server, name, config, callback)` requires at least one boolean
behavior hint, rejects unknown/invalid hints, preserves the receiver and returns
the SDK's registration object. Generic schema-based SDKs may require explicit
callback parameter types; the helper does not reproduce Zod inference.

Annotations are client hints, not authorization or enforcement. Every server
must continue checking permission and mutation policy in its own implementation.
They add bytes to tool listings and are not a token-saving mechanism.

## What stays in each server

- Signing domains, secret names, route-specific secret acceptance, token lifetimes
  and redirect policy.
- Durable Object class, binding and object names, plus append-only migration tags.
- Provider-managed inbound OAuth, outbound OAuth request signing and consent flows.
- Outbound account identity, Google scopes, refresh credentials and account routes.
- Read-only allowlists, exclusion rules, argument policy and bearer-collision checks.
- Ledger expiry grace periods and language-specific authentication implementations.

## Execution and verification

**Trigger and invocation chain:** importing a module does not contact a service.
A consumer handler invokes these functions; `claimAuthCode` calls the bound
Durable Object, whose synchronous SQLite method consumes the claim. `fetchBounded`
contacts only the URL supplied by its caller. Installing from Git invokes
`prepare`, which runs the two TypeScript compilations for portable and Worker APIs.

**Reads and writes:** the ledger reads/writes `redeemed(code_id, expires_at)` in
its caller's SQLite store. Other modules format in-memory data or call supplied
HTTP endpoints. The package reads no environment secrets and creates no cron,
service, account or deployed resource. Builds write only `dist/`.

**Closed loop:** no production monitor is installed. Consumers own logs, latency
monitoring and failure handling. Local tests catch behavioral regressions;
conformance verifies the same algorithm against actual Node SQLite. Python and
Cloudflare runtime verification require their respective adopting environments.
Report reproducible failures to the package maintainer through the repository.

**Failure modes:** preserve ledger identity or invalidate old signatures before
switching stores; fail closed on unavailable ledgers; paginate records that exceed
a result budget; handle `DeadlineExceeded` and truncated HTTP bodies explicitly.
No test here proves real Cloudflare RPC scheduling or production latency.

```sh
npm ci
npm run build
npm test
npm test -- --test-name-pattern='mutation'
npm test -- --test-name-pattern='budget'
npm run conformance
```

Node's SQLite API may print an experimental warning. Tests use actual local
SQLite and stubbed fetch, with no network calls. JSON fixtures live in
`src/conformance/` and are copied by the compiler into `dist/conformance/`.
The runner accepts a SQLite adapter so another runtime can execute the same cases.

**Source of truth:** `src/` defines the API, `test/` defines its executable
contracts, `src/conformance/*.json` defines the language-neutral cases, and
`package-lock.json` pins the build tools. Release consumers should pin a tag and
review explicit version bumps.

# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/auny-ai/mcp-core/security/advisories/new).
Please include the affected module, a reproduction and the version or commit.

You will get an acknowledgement within 7 days. Fixes ship as a new tagged
version with a CHANGELOG entry.

## Scope

This package handles single-use authorization code claims and bounded network
reads for MCP servers. Reports about claim atomicity, replay, retry of
non-idempotent requests, credential leakage in error messages, or result
budget bypasses are especially welcome.

## Supported versions

Only the latest tagged version receives fixes.

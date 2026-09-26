# Audit brief: AUN-1317 unit A, @auny/mcp-core v0.1.0

- **Author:** Codex (high). **Auditor:** Claude code-reviewer (different family), one pass with companion question.

## ROUND 1 2026-09-26

- **F1 MEDIUM, FIXED (by Claude, non-author):** LICENSE and a test pinned the owner's full legal name for a public repo; other public repos use the handle. Now "AunySillyMe".
- **F2 LOW/MEDIUM, FIXED:** the byte budget only bound results built by the package's constructors; a hand-assembled multi-part result could exceed it. Added `withinBudget` / `assertWithinBudget` and a README note; `test/within-budget.test.mjs` red (0 pass, 3 fail) before, green after.
- **Checked clean by auditor:** safe:false + retries throws with zero network calls; 503 + Retry-After on safe:false fetched once; userinfo and query redacted; consumeCode synchronous with expiry before purge; zero runtime dependencies; clean-copy install runs prepare and builds; 53/53 then 56/56 tests; conformance 14/14 + 6/6; no secrets or internal names in the tree.

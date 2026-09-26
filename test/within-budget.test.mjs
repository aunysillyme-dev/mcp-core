import test from 'node:test';
import assert from 'node:assert/strict';
import * as results from '../dist/results.js';

// Audit ROUND 1 (2026-09-26): the budget only bound results built by this
// module's constructors. A hand-assembled multi-part result could exceed it,
// so consumers need a check they can run on any ToolResult.
const threeParts = { content: [0, 1, 2].map(() => ({ type: 'text', text: 'x'.repeat(900) })) };

test('budget: withinBudget rejects a hand-built multi-part result over the budget', () => {
  assert.equal(typeof results.withinBudget, 'function');
  assert.equal(results.withinBudget(threeParts, { maxBytes: 1000 }), false);
});

test('budget: withinBudget accepts a result at or under the budget', () => {
  assert.equal(results.withinBudget(threeParts, { maxBytes: 100_000 }), true);
  assert.equal(results.withinBudget(results.ok({ a: 1 })), true);
});

test('budget: assertWithinBudget throws with the measured size', () => {
  assert.throws(() => results.assertWithinBudget(threeParts, { maxBytes: 1000 }), /exceeds budget/);
});

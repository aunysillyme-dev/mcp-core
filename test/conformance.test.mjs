import test from 'node:test';
import assert from 'node:assert/strict';
import { runLedgerConformance, runCodeIdConformance, consumeFixtures, codeIdFixtures } from '../dist/conformance.js';
import { makeSql } from './sqlite.mjs';

test('conformance language-neutral consume fixtures pass on real SQLite', () => {
  const report = runLedgerConformance(makeSql);
  assert.deepEqual(report.failures, []);
  assert.equal(report.failed, 0);
  assert.equal(report.passed, consumeFixtures.reduce((n, fixture) => n + fixture.steps.length, 0));
});
test('conformance code ID fixtures retain both derivation schemes', async () => {
  const report = await runCodeIdConformance();
  assert.equal(report.failed, 0);
  assert.equal(report.passed, codeIdFixtures.length);
  assert.deepEqual(new Set(codeIdFixtures.map(f => f.codeIdScheme)), new Set(['sha256-b64url-43', 'sha256-b64url-32']));
});
test('conformance runner detects a broken changes() result', () => {
  const report = runLedgerConformance(() => {
    const sql = makeSql();
    return { exec(query, ...bindings) {
      if (query === 'SELECT changes() AS n') return { one: () => ({ n: 0 }) };
      return sql.exec(query, ...bindings);
    }, close: () => sql.close() };
  });
  assert.ok(report.failed > 0);
  assert.ok(report.failures.length > 0);
});

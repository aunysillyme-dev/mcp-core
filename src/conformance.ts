import consumeData from './conformance/consume.json' with { type: 'json' };
import codeIdData from './conformance/code_id.json' with { type: 'json' };
import {
  consumeCode, codeIdOf, LEDGER_CREATE_SQL, CODE_ID_PATTERN, LEGACY_CODE_ID_PATTERN,
  type SqlStorageLike,
} from './ledger.js';

export interface ConsumeFixture {
  name: string;
  codeIdScheme: string;
  steps: Array<{
    codeId: string; expiresAt: number; now: number;
    expected: boolean | null; error?: string; sqlCalls: number;
  }>;
}
export interface CodeIdFixture { codeIdScheme: string; input: string; expected: string }
export const consumeFixtures: readonly ConsumeFixture[] = consumeData;
export const codeIdFixtures: readonly CodeIdFixture[] = codeIdData;
export interface ConformanceReport {
  passed: number;
  failed: number;
  failures: Array<{ fixture: string; step: number; message: string }>;
}
export interface ConformanceSql extends SqlStorageLike { close?(): void }

/** Supply a fresh SQLite store for each sequence. No in-memory emulation is built in. */
export function runLedgerConformance(createSql: () => ConformanceSql): ConformanceReport {
  const report: ConformanceReport = { passed: 0, failed: 0, failures: [] };
  for (const fixture of consumeFixtures) {
    const sql = createSql();
    try {
      sql.exec(LEDGER_CREATE_SQL);
      fixture.steps.forEach((step, index) => {
        let calls = 0;
        const traced: SqlStorageLike = { exec(query, ...bindings) {
          calls++;
          return sql.exec(query, ...bindings);
        } };
        const pattern = fixture.codeIdScheme === 'sha256-b64url-43'
          ? CODE_ID_PATTERN : LEGACY_CODE_ID_PATTERN;
        let result: boolean | undefined;
        let thrown: unknown;
        try { result = consumeCode(traced, step.codeId, step.expiresAt, step.now, pattern); }
        catch (error) { thrown = error; }
        const outcomeMatches = step.error !== undefined
          ? thrown instanceof Error && thrown.message.includes(step.error)
          : thrown === undefined && result === step.expected;
        if (outcomeMatches && calls === step.sqlCalls) report.passed++;
        else {
          report.failed++;
          report.failures.push({ fixture: fixture.name, step: index,
            message: `Unexpected outcome or SQL count (expected ${step.sqlCalls}, got ${calls})` });
        }
      });
    } finally { sql.close?.(); }
  }
  return report;
}

/** The 32-character scheme hashes the caller's input, then retains its first 32 characters.
 * Consumers choose what is hashed: legacy Python hashes a code signature, TS a full code.
 */
export async function runCodeIdConformance(): Promise<ConformanceReport> {
  const report: ConformanceReport = { passed: 0, failed: 0, failures: [] };
  for (const [index, fixture] of codeIdFixtures.entries()) {
    const digest = await codeIdOf(fixture.input);
    const actual = fixture.codeIdScheme === 'sha256-b64url-32' ? digest.slice(0, 32) : digest;
    if (actual === fixture.expected) report.passed++;
    else {
      report.failed++;
      report.failures.push({ fixture: fixture.codeIdScheme, step: index, message: 'Code ID mismatch' });
    }
  }
  return report;
}

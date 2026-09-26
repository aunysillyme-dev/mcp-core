import { DatabaseSync } from 'node:sqlite';
import { runLedgerConformance, runCodeIdConformance } from '../dist/conformance.js';
function createSql() {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query, ...bindings) {
      const statement = db.prepare(query);
      if (query.startsWith('SELECT')) return { one: () => statement.get(...bindings) };
      statement.run(...bindings);
      return { one() { throw new Error('No rows'); } };
    },
    close() { db.close(); },
  };
}
const ledger = runLedgerConformance(createSql);
const codeIds = await runCodeIdConformance();
console.log(JSON.stringify({ ledger, codeIds }, null, 2));
if (ledger.failed || codeIds.failed) process.exitCode = 1;

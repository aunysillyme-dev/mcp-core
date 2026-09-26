import { DatabaseSync } from 'node:sqlite';

export function makeSql() {
  const db = new DatabaseSync(':memory:');
  const statements = [];
  return {
    db,
    statements,
    exec(query, ...bindings) {
      statements.push({ query, bindings });
      const stmt = db.prepare(query);
      if (query.startsWith('SELECT')) {
        return { one: () => stmt.get(...bindings), rowsWritten: 2 };
      }
      stmt.run(...bindings);
      // Deliberately misleading, matching runtimes counting index writes too.
      return { one() { throw new Error('No rows'); }, rowsWritten: 2 };
    },
    close() { db.close(); },
  };
}

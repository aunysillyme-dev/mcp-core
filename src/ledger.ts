/** Single-use claims must remain synchronous: no suspension between purge and insert. */
export const LEDGER_CREATE_SQL =
  'CREATE TABLE IF NOT EXISTS redeemed (code_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)';
export const LEDGER_NAME = 'authorization-codes';
export const CODE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// The Python adapter historically validates length only. Preserve that contract.
export const LEGACY_CODE_ID_PATTERN = /^[\s\S]{32}$/u;

export interface SqlStorageLike {
  exec(q: string, ...b: unknown[]): { one(): Record<string, unknown> };
}
export interface CodeLedgerBinding {
  idFromName(name: string): unknown;
  get(id: unknown): { consume(codeId: string, expiresAt: number): Promise<boolean> };
}
export class CodeLedgerUnavailableError extends Error {
  override name = 'CodeLedgerUnavailableError';
}

export function consumeCode(
  sql: SqlStorageLike,
  codeId: string,
  expiresAt: number,
  now: number,
  codeIdPattern: RegExp = CODE_ID_PATTERN,
): boolean {
  // A fresh expression avoids global/sticky lastIndex state changing acceptance.
  const pattern = new RegExp(codeIdPattern.source, codeIdPattern.flags);
  const match = typeof codeId === 'string' ? pattern.exec(codeId) : null;
  if (!match || match.index !== 0 || match[0] !== codeId) {
    throw new Error('consumeCode: invalid codeId');
  }
  if (!Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(now)) {
    throw new Error('consumeCode: invalid time');
  }
  // Refuse before purge: an expired replay must not erase its own redeemed row.
  if (now > expiresAt) return false;
  sql.exec('DELETE FROM redeemed WHERE expires_at < ?', now);
  sql.exec('INSERT OR IGNORE INTO redeemed (code_id, expires_at) VALUES (?, ?)', codeId, expiresAt);
  // Index writes can inflate rowsWritten; SQLite changes() counts the claim row.
  return Number(sql.exec('SELECT changes() AS n').one().n) === 1;
}

export async function codeIdOf(code: string): Promise<string> {
  if (typeof code !== 'string') throw new TypeError('codeIdOf: code must be a string');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export async function claimAuthCode(
  ledger: CodeLedgerBinding,
  code: string,
  expiresAt: number,
): Promise<boolean> {
  const codeId = await codeIdOf(code);
  try {
    const stub = ledger.get(ledger.idFromName(LEDGER_NAME));
    const result = await stub.consume(codeId, expiresAt);
    return result === true;
  } catch {
    // RPC failures may embed requests or credentials. Fail closed without reflecting them.
    throw new CodeLedgerUnavailableError('Authorization code ledger is unavailable');
  }
}

export interface LedgerContext { storage: { sql: SqlStorageLike } }
// The variadic constructor is the standard TypeScript mixin contract. The context
// is taken from the constructor, not Base.ctx, which Workers correctly makes protected.
export function makeCodeLedger<TBase extends abstract new (...args: any[]) => object>(
  Base: TBase,
  codeIdPattern: RegExp = CODE_ID_PATTERN,
): TBase & (abstract new (...args: any[]) => { consume(codeId: string, expiresAt: number): boolean }) {
  abstract class Ledger extends Base {
    readonly #sql: SqlStorageLike;
    constructor(...args: any[]) {
      super(...args);
      const ctx = args[0] as LedgerContext;
      this.#sql = ctx.storage.sql;
      this.#sql.exec(LEDGER_CREATE_SQL);
    }
    consume(codeId: string, expiresAt: number): boolean {
      return consumeCode(this.#sql, codeId, expiresAt, Date.now(), codeIdPattern);
    }
  }
  return Ledger;
}

export type CodeIdScheme = 'sha256-b64url-43' | 'sha256-b64url-32';
export interface LEDGER_IDENTITY {
  class: string;
  objectName: string;
  codeIdScheme: CodeIdScheme;
  signingDomain: string;
}

/** Compare with the last deployed identity, not another copy of today's constants.
 * The caller still verifies signatures before calling claimAuthCode. This validator
 * cannot detect an empty replacement store whose declared identity was not changed.
 */
export function validateLedgerIdentity(
  identity: unknown,
  previous?: LEDGER_IDENTITY,
): asserts identity is LEDGER_IDENTITY {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    throw new TypeError('Invalid ledger identity');
  }
  const value = identity as Record<string, unknown>;
  for (const field of ['class', 'objectName', 'codeIdScheme', 'signingDomain']) {
    if (typeof value[field] !== 'string' || !value[field].trim()) {
      throw new TypeError(`Invalid ledger identity field: ${field}`);
    }
  }
  if (value.codeIdScheme !== 'sha256-b64url-43' && value.codeIdScheme !== 'sha256-b64url-32') {
    throw new TypeError('Unsupported ledger codeIdScheme');
  }
  if (previous !== undefined) {
    validateLedgerIdentity(previous);
    const changed = value.class !== previous.class || value.objectName !== previous.objectName
      || value.codeIdScheme !== previous.codeIdScheme;
    if (changed && value.signingDomain === previous.signingDomain) {
      throw new Error('Ledger storage identity changed without a signingDomain change');
    }
  }
}

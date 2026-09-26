import { DurableObject } from 'cloudflare:workers';
import { consumeCode, CODE_ID_PATTERN, LEDGER_CREATE_SQL } from './ledger.js';
export * from './ledger.js';

/** Extend under the existing exported class name and keep migration history intact. */
export class CodeLedger<Env = unknown> extends DurableObject<Env> {
  protected readonly codeIdPattern: RegExp = CODE_ID_PATTERN;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(LEDGER_CREATE_SQL);
  }
  consume(codeId: string, expiresAt: number): boolean {
    return consumeCode(this.ctx.storage.sql, codeId, expiresAt, Date.now(), this.codeIdPattern);
  }
}

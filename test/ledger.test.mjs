import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  LEDGER_CREATE_SQL, LEDGER_NAME, consumeCode, codeIdOf, claimAuthCode,
  CodeLedgerUnavailableError, makeCodeLedger, validateLedgerIdentity, LEGACY_CODE_ID_PATTERN,
} from '../dist/ledger.js';
import { makeSql } from './sqlite.mjs';

const id = 'a'.repeat(43);
function setup(t) {
  const sql = makeSql();
  sql.exec(LEDGER_CREATE_SQL);
  t.after(() => sql.close());
  return sql;
}

test('ledger first use, reuse and changes() instead of rowsWritten', t => {
  const sql = setup(t);
  assert.equal(consumeCode(sql, id, 100, 10), true);
  assert.equal(consumeCode(sql, id, 100, 20), false);
});

test('ledger expired-before-purge preserves redeemed row', t => {
  const sql = setup(t);
  assert.equal(consumeCode(sql, id, 100, 10), true);
  const before = sql.statements.length;
  assert.equal(consumeCode(sql, id, 100, 101), false);
  assert.equal(sql.statements.length, before);
  assert.equal(sql.db.prepare('SELECT count(*) AS n FROM redeemed').get().n, 1);
  assert.equal(consumeCode(sql, 'b'.repeat(43), 200, 101), true);
  assert.equal(sql.db.prepare('SELECT count(*) AS n FROM redeemed').get().n, 1);
});

test('ledger expiry boundary and both code-id schemes', t => {
  const sql = setup(t);
  assert.equal(consumeCode(sql, id, 100, 100), true);
  assert.equal(consumeCode(sql, 'c'.repeat(32), 100, 100, LEGACY_CODE_ID_PATTERN), true);
  assert.throws(() => consumeCode(sql, 'd'.repeat(32), 100, 100));
  const pattern = /^[A-Za-z0-9_-]{43}$/g;
  pattern.lastIndex = 7;
  assert.equal(consumeCode(sql, 'e'.repeat(43), 100, 100, pattern), true);
  assert.equal(consumeCode(sql, 'e'.repeat(43), 100, 100, pattern), false);
  assert.equal(pattern.lastIndex, 7);
});

test('ledger malformed ids and invalid times fail before SQL', t => {
  const sql = setup(t);
  const before = sql.statements.length;
  for (const bad of ['', 'x'.repeat(42), 'x'.repeat(44), '/'.repeat(43), id + '\n', null, 5]) {
    assert.throws(() => consumeCode(sql, bad, 100, 10), /invalid codeId/);
  }
  for (const bad of [NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, true, '100']) {
    assert.throws(() => consumeCode(sql, id, bad, 10), /invalid time/);
    assert.throws(() => consumeCode(sql, id, 100, bad), /invalid time/);
  }
  assert.equal(sql.statements.length, before);
});

test('ledger codeIdOf is SHA-256 base64url without padding', async () => {
  assert.equal(await codeIdOf('abc'), 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
  assert.match(await codeIdOf(''), /^[A-Za-z0-9_-]{43}$/);
  await assert.rejects(codeIdOf(null), TypeError);
});

test('ledger claim hashes code, selects stable object and requires strict true', async () => {
  const code = 'fixture-only-code';
  for (const response of [true, false, 1, 'true', {}, null, undefined]) {
    const ledger = {
      idFromName(name) { assert.equal(name, LEDGER_NAME); return 'object-id'; },
      get(objectId) {
        assert.equal(objectId, 'object-id');
        return { async consume(hash, expiry) {
          assert.equal(hash, await codeIdOf(code)); assert.equal(expiry, 100);
          return response;
        } };
      },
    };
    assert.equal(await claimAuthCode(ledger, code, 100), response === true);
  }
});

test('ledger missing binding and RPC failures fail closed with sanitized errors', async () => {
  const failure = () => { throw new Error('upstream-private-detail'); };
  for (const binding of [undefined, {}, { idFromName: failure },
    { idFromName: () => 'id', get: failure },
    { idFromName: () => 'id', get: () => ({ consume: failure }) }]) {
    await assert.rejects(claimAuthCode(binding, 'fixture', 100), err => {
      assert.ok(err instanceof CodeLedgerUnavailableError);
      assert.equal(err.message.includes('upstream-private-detail'), false);
      assert.equal(err.cause, undefined);
      return true;
    });
  }
});

test('ledger concurrency: 20 claims of one id yield exactly 1 true', async t => {
  const sql = setup(t);
  const ledger = { idFromName: () => 'id', get: () => ({
    async consume(hash, expiresAt) { return consumeCode(sql, hash, expiresAt, 10); },
  }) };
  const results = await Promise.all(Array.from({ length: 20 }, () => claimAuthCode(ledger, 'one-code', 100)));
  assert.equal(results.filter(result => result === true).length, 1);
});

test('ledger mixin preserves named subclass and initializes schema', t => {
  const sql = makeSql(); t.after(() => sql.close());
  class Base { constructor(ctx, env) { this.context = ctx; this.environment = env; } }
  class ExistingLedger extends makeCodeLedger(Base) {}
  const ctx = { storage: { sql } }; const env = { marker: true };
  const instance = new ExistingLedger(ctx, env);
  assert.equal(instance.constructor.name, 'ExistingLedger');
  assert.equal(instance.environment, env);
  const expiry = Date.now() + 10000;
  assert.equal(instance.consume(id, expiry), true);
  assert.equal(instance.consume(id, expiry), false);
});

const identity = { class: 'CodeLedger', objectName: LEDGER_NAME,
  codeIdScheme: 'sha256-b64url-43', signingDomain: 'example/authorization-code/v2.' };

test('ledger identity validation requires a domain bump for each storage change', () => {
  validateLedgerIdentity(identity);
  validateLedgerIdentity({ ...identity }, identity);
  for (const change of [{ class: 'NewLedger' }, { objectName: 'new-store' }, { codeIdScheme: 'sha256-b64url-32' }]) {
    assert.throws(() => validateLedgerIdentity({ ...identity, ...change }, identity), /signingDomain/);
    validateLedgerIdentity({ ...identity, ...change, signingDomain: 'example/authorization-code/v3.' }, identity);
  }
  for (const invalid of [null, [], {}, { ...identity, signingDomain: ' ' }, { ...identity, codeIdScheme: 'unknown' }]) {
    assert.throws(() => validateLedgerIdentity(invalid));
  }
});

test('ledger reset trap: old signature fails before empty replacement ledger is consulted', async t => {
  const key = randomBytes(32);
  const sign = (domain, payload) => createHmac('sha256', key).update(domain + payload).digest();
  const payload = 'fixture-payload'; const signature = sign(identity.signingDomain, payload);
  let calls = 0;
  const redeem = (sql, domain) => {
    if (!timingSafeEqual(signature, sign(domain, payload))) return false;
    calls++;
    return consumeCode(sql, id, 100, 10);
  };
  const oldStore = setup(t);
  assert.equal(redeem(oldStore, identity.signingDomain), true);
  const replacement = setup(t);
  const newIdentity = { ...identity, objectName: 'replacement-store',
    signingDomain: 'example/authorization-code/v3.' };
  validateLedgerIdentity(newIdentity, identity);
  // Validate the deployment identity before accepting requests on replacement storage.
  assert.equal(redeem(replacement, newIdentity.signingDomain), false);
  assert.equal(calls, 1);
});

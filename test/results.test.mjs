import test from 'node:test';
import assert from 'node:assert/strict';
import { ok, okText, fail, absent, partial, run, clampPage, boundedInt, DEFAULT_BUDGET } from '../dist/results.js';

const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const payload = result => JSON.parse(result.content[0].text);

test('results: typed success and failure envelopes', async () => {
  assert.deepEqual(payload(ok({ id: 1 })), { data: { id: 1 } });
  assert.deepEqual(ok({ id: 1 }).structuredContent, { data: { id: 1 } });
  assert.equal(fail(new Error('broken')).isError, true);
  assert.equal(absent('document').isError, true);
  assert.equal((await run(async () => { throw Error('broken'); })).isError, true);
  assert.deepEqual(payload(await run(async () => [1])), { data: [1] });
});

test('results budget: oversized records fit UTF-8 serialized envelope with cursor', () => {
  const rows = Array.from({ length: 40 }, (_, id) => ({ id, label: '你好😀'.repeat(8) }));
  const result = ok(rows, { maxBytes: 1000 });
  const body = payload(result);
  assert.ok(bytes(result) <= 1000);
  assert.equal(body.truncated, true);
  assert.ok(body.data.length > 0 && body.data.length < rows.length);
  assert.equal(body.cursor, `offset:${body.data.length}`);
  assert.deepEqual(body.data, rows.slice(0, body.data.length));
  assert.deepEqual(result.structuredContent, body);
});

test('results budget: tiny impossible budget and unpageable payload fail explicitly', () => {
  assert.throws(() => ok([1], { maxBytes: 1 }), RangeError);
  assert.throws(() => ok({ huge: 'x'.repeat(1000) }, { maxBytes: 200 }), /paginate/);
  assert.throws(() => ok(['x'.repeat(1000)], { maxBytes: 200 }), /record/);
  for (const maxBytes of [NaN, Infinity, 0, -1, 1.5]) {
    assert.throws(() => ok([], { maxBytes }), RangeError);
  }
});

test('results budget: object property and scalar cursors describe exact retained prefixes', () => {
  const object = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`field${i}`, 'x'.repeat(20)]));
  const result = ok(object, { maxBytes: 500 });
  const body = payload(result);
  const count = Number(body.cursor.split(':')[1]);
  assert.match(body.cursor, /^property:/);
  assert.equal(body.truncated, true);
  assert.ok(bytes(result) <= 500);
  assert.deepEqual(body.data, Object.fromEntries(Object.entries(object).slice(0, count)));
  const value = '😀hello'.repeat(100);
  const scalar = ok(value, { maxBytes: 500 });
  const scalarBody = payload(scalar);
  assert.match(scalarBody.cursor, /^scalar:/);
  assert.ok(bytes(scalar) <= 500);
  assert.equal(scalarBody.data, Array.from(value).slice(0, Number(scalarBody.cursor.split(':')[1])).join(''));
});

test('results budget: text remains valid and Unicode cursor resumes exactly', () => {
  const text = '😀你好'.repeat(300);
  const result = okText(text, { maxBytes: 500 });
  const body = payload(result);
  assert.ok(bytes(result) <= 500);
  assert.equal(body.truncated, true);
  const offset = Number(body.cursor.split(':')[1]);
  assert.equal(body.text, Array.from(text).slice(0, offset).join(''));
  assert.ok(!body.text.includes('\uFFFD'));
  assert.equal(okText('plain').content[0].text, 'plain');
});

test('results budget: errors redact URL secrets and stay bounded', () => {
  const result = fail(Error('Cannot get https://user:pass@example.com/path?token=private#fragment ' + 'x'.repeat(DEFAULT_BUDGET.maxBytes)));
  assert.equal(result.isError, true);
  assert.ok(bytes(result) <= DEFAULT_BUDGET.maxBytes);
  assert.ok(!result.content[0].text.includes('user:pass'));
  assert.ok(!result.content[0].text.includes('token=private'));
  assert.ok(!result.content[0].text.includes('#fragment'));
  assert.match(fail('https://example.com/?visible=yes', { redactUrls: false }).content[0].text, /visible=yes/);
});

test('results budget: partial preserves created resource and resume or fails explicitly', () => {
  const result = partial({ id: 'created-id' }, { cursor: 'next', next_action: 'attach file' });
  assert.equal(payload(result).partial, true);
  assert.equal(payload(result).data.id, 'created-id');
  assert.equal(payload(result).cursor, 'next');
  assert.equal(payload(result).next_action, 'attach file');
  assert.throws(() => partial({ id: 'x'.repeat(DEFAULT_BUDGET.maxBytes) }, { next_action: 'continue' }), /preserve/);
  assert.throws(() => partial({ id: 'created-id' }, {}), /resume/);
});

test('results budget: run failures honor caller ceiling and data is snapshotted', async () => {
  const result = await run(async () => { throw Error('x'.repeat(2000)); }, { maxBytes: 400 });
  assert.equal(result.isError, true);
  assert.ok(bytes(result) <= 400);
  const data = { items: [1] };
  const snapshot = ok(data, { maxBytes: 200 });
  data.items.push(...Array(100).fill(2));
  assert.deepEqual(snapshot.structuredContent, { data: { items: [1] } });
  assert.ok(bytes(snapshot) <= 200);
});

test('results: page clamp uses last included row cursor and rejects invalid limits', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(clampPage(rows, 2, row => row.id), { rows: rows.slice(0, 2), next_cursor: 'b', complete: false });
  assert.deepEqual(clampPage(rows, 3, row => row.id), { rows, complete: true });
  assert.deepEqual(clampPage([], 2, row => row.id), { rows: [], complete: true });
  for (const limit of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => clampPage(rows, limit, row => row.id), RangeError);
});

test('results: bounded integer validates without coercion and exposes JSON Schema', () => {
  const schema = boundedInt(1, 100, 20);
  assert.equal(schema.parse(undefined), 20);
  assert.equal(schema.parse(1), 1);
  assert.equal(schema.parse(100), 100);
  for (const value of ['2', 1.2, 0, 101, NaN, Infinity, null]) {
    assert.equal(schema.safeParse(value).success, false);
    assert.throws(() => schema.parse(value), RangeError);
  }
  assert.deepEqual(schema.jsonSchema, { type: 'integer', minimum: 1, maximum: 100, default: 20 });
  assert.throws(() => boundedInt(2, 1, 1), RangeError);
  assert.throws(() => boundedInt(1, 2, 3), RangeError);
});

test('results: serialization refuses unsupported values instead of silently losing fields', () => {
  assert.throws(() => ok({ value: undefined }), TypeError);
  assert.throws(() => ok({ value: NaN }), TypeError);
  assert.throws(() => ok({ value: 1n }), TypeError);
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => ok(cyclic), TypeError);
});

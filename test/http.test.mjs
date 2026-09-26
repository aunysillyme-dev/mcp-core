import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchBounded, redactUrl, DeadlineExceeded } from '../dist/http.js';

const policy = { deadlineMs: 1000, maxBodyBytes: 128, safe: true };
const url = 'https://example.test/resource';
function stub(t, implementation) {
  t.mock.method(globalThis, 'fetch', implementation);
}

test('mutation safe:false with retries throws synchronously before fetch', (t) => {
  let calls = 0;
  stub(t, async () => { calls++; return new Response('ok'); });
  assert.throws(() => fetchBounded(url, {}, { ...policy, safe: false, retries: 1 }), /retry|retries/i);
  assert.equal(calls, 0);
});

test('mutation safe:false never retries 5xx or honors Retry-After', async (t) => {
  let calls = 0;
  stub(t, async () => { calls++; return new Response('failure', { status: 503, headers: { 'Retry-After': '60' } }); });
  const result = await fetchBounded(url, { method: 'POST' }, { ...policy, safe: false });
  assert.equal(result.status, 503);
  assert.equal(result.attempts, 1);
  assert.equal(result.retryAfterMs, undefined);
  assert.equal(calls, 1);
});

test('http returns status headers and complete UTF8 text', async (t) => {
  stub(t, async () => new Response('hello 🦋', { status: 201, headers: { 'X-Example': 'yes' } }));
  const result = await fetchBounded(url, {}, policy);
  assert.equal(result.bodyText, 'hello 🦋');
  assert.equal(result.status, 201);
  assert.equal(result.headers.get('X-Example'), 'yes');
  assert.equal(result.truncated, false);
});

test('http bounds bytes and cancels a body without splitting UTF8', async (t) => {
  let cancelled = false;
  stub(t, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('ab🦋rest')); },
    cancel() { cancelled = true; },
  })));
  const result = await fetchBounded(url, {}, { ...policy, maxBodyBytes: 4 });
  assert.equal(result.bodyText, 'ab');
  assert.equal(result.truncated, true);
  assert.equal(cancelled, true);
  assert.ok(new TextEncoder().encode(result.bodyText).length <= 4);
});

test('http exact body cap is not reported truncated', async (t) => {
  stub(t, async () => new Response('abcd'));
  const result = await fetchBounded(url, {}, { ...policy, maxBodyBytes: 4 });
  assert.equal(result.bodyText, 'abcd');
  assert.equal(result.truncated, false);
});

test('http safe retry honors Retry-After and cancels discarded response', async (t) => {
  let calls = 0;
  let cancelled = false;
  stub(t, async () => {
    calls++;
    if (calls === 1) return new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      status: 429, headers: { 'Retry-After': '0' },
    });
    return new Response('recovered');
  });
  const result = await fetchBounded(url, {}, { ...policy, retries: 1 });
  assert.equal(calls, 2);
  assert.equal(result.attempts, 2);
  assert.equal(result.bodyText, 'recovered');
  assert.equal(cancelled, true);
});

test('http deadline covers Retry-After backoff', async (t) => {
  let calls = 0;
  stub(t, async () => { calls++; return new Response('', { status: 503, headers: { 'Retry-After': '60' } }); });
  await assert.rejects(fetchBounded(url, {}, { ...policy, deadlineMs: 20, retries: 1 }), DeadlineExceeded);
  assert.equal(calls, 1);
});

test('http deadline aborts noncooperative fetch', async (t) => {
  let signal;
  stub(t, (_url, init) => { signal = init.signal; return new Promise(() => {}); });
  await assert.rejects(fetchBounded(url, {}, { ...policy, deadlineMs: 20 }), DeadlineExceeded);
  assert.equal(signal.aborted, true);
});

test('http deadline covers stalled body reads and cancels reader', async (t) => {
  let cancelled = false;
  stub(t, async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await assert.rejects(fetchBounded(url, {}, { ...policy, deadlineMs: 20 }), DeadlineExceeded);
  assert.equal(cancelled, true);
});

test('http external abort reason is redacted', async (t) => {
  stub(t, () => new Promise(() => {}));
  const controller = new AbortController();
  const result = fetchBounded(url, { signal: controller.signal }, policy);
  controller.abort('private-credential');
  await assert.rejects(result, (error) => !String(error).includes('private-credential') && /aborted/.test(error.message));
});

test('http errors redact userinfo query fragment and original cause', async (t) => {
  const sensitive = 'https://user:pass@example.test/resource?signature=private#fragment';
  stub(t, async () => { throw new Error(`upstream failure ${sensitive}`); });
  await assert.rejects(fetchBounded(sensitive, {}, policy), (error) => {
    assert.equal(error.message, 'Fetch failed for https://example.test/resource');
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(redactUrl(sensitive), url);
  assert.equal(redactUrl('malformed private-token'), '[invalid URL]');
  assert.equal(redactUrl('data:text/plain,private'), '[redacted URL]');
});

test('http retryOn exceptions cannot leak URLs', async (t) => {
  stub(t, async () => new Response('failed', { status: 500 }));
  await assert.rejects(fetchBounded(url, {}, {
    ...policy, retries: 1, retryOn() { throw new Error('private-token'); },
  }), (error) => !String(error).includes('private-token'));
});

test('http validates policy before dispatch', (t) => {
  stub(t, () => { throw new Error('must not dispatch'); });
  for (const overrides of [{ retries: -1 }, { retries: 0.5 }, { deadlineMs: 0 }, { maxBodyBytes: -1 }, { safe: undefined }]) {
    assert.throws(() => fetchBounded(url, {}, { ...policy, ...overrides }));
  }
});

test('http request inputs preserve bodies and honor custom retry status', async (t) => {
  const bodies = [];
  stub(t, async (request) => {
    bodies.push(await request.text());
    return new Response('result', {
      status: bodies.length === 1 ? 409 : 200,
      headers: { 'Retry-After': '0' },
    });
  });
  const request = new Request(url, { method: 'POST', body: 'safe query' });
  const result = await fetchBounded(request, {}, { ...policy, retries: 1, retryOn: (status) => status === 409 });
  assert.deepEqual(bodies, ['safe query', 'safe query']);
  assert.equal(result.attempts, 2);
  assert.equal(request.bodyUsed, false);
});

test('http honorRetryAfter false uses bounded backoff instead', async (t) => {
  let calls = 0;
  stub(t, async () => {
    calls++;
    return new Response('', { status: calls === 1 ? 503 : 200, headers: { 'Retry-After': '60' } });
  });
  const result = await fetchBounded(url, {}, { ...policy, retries: 1, honorRetryAfter: false });
  assert.equal(result.attempts, 2);
});

test('http safe network failures retry with a bounded backoff', async (t) => {
  let calls = 0;
  stub(t, async () => {
    if (++calls === 1) throw new Error('temporary failure');
    return new Response('recovered');
  });
  assert.equal((await fetchBounded(url, {}, { ...policy, retries: 1 })).attempts, 2);
});

test('mutation safe:false never retries a network failure', async (t) => {
  let calls = 0;
  stub(t, async () => { calls++; throw new Error('network failed'); });
  await assert.rejects(fetchBounded(url, {}, { ...policy, safe: false }), /Fetch failed/);
  assert.equal(calls, 1);
});

test('http UTF8 decoding spans chunks and drops only truncated final code point', async (t) => {
  const bytes = new TextEncoder().encode('🦋🦋');
  stub(t, async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 2));
      controller.enqueue(bytes.subarray(2));
      controller.close();
    },
  })));
  const result = await fetchBounded(url, {}, { ...policy, maxBodyBytes: 6 });
  assert.equal(result.bodyText, '🦋');
  assert.equal(result.truncated, true);
});

test('http rejects malformed UTF8 without leaking decoder errors', async (t) => {
  stub(t, async () => new Response(new Uint8Array([255])));
  await assert.rejects(fetchBounded(url, {}, policy), { message: `Fetch failed for ${url}` });
});

test('http body errors are sanitized and never trigger replay', async (t) => {
  let calls = 0;
  stub(t, async () => {
    calls++;
    return new Response(new ReadableStream({
      start(controller) { controller.error(new Error('private upstream URL')); },
    }));
  });
  await assert.rejects(fetchBounded(url, {}, { ...policy, retries: 1 }), { message: `Fetch failed for ${url}` });
  assert.equal(calls, 1);
});

test('http already aborted input prevents dispatch', async (t) => {
  let calls = 0;
  stub(t, async () => { calls++; return new Response('unexpected'); });
  const controller = new AbortController();
  controller.abort('private');
  await assert.rejects(fetchBounded(new Request(url, { signal: controller.signal }), {}, policy), /aborted/);
  assert.equal(calls, 0);
});

test('http streaming request retry is refused before dispatch', (t) => {
  stub(t, () => { throw new Error('must not dispatch'); });
  assert.throws(() => fetchBounded(url, { method: 'POST', body: new ReadableStream() }, {
    ...policy, retries: 1,
  }), /streaming request/);
});

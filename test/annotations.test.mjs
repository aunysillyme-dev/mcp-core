import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  READ_ONLY, IDEMPOTENT_WRITE, WRITE, DESTRUCTIVE, SPENDS_MONEY, OPEN_WORLD,
  assertAnnotations, registerTool,
} from '../dist/annotations.js';

test('annotations: presets state the intended behavior and are immutable', () => {
  const expected = [
    [READ_ONLY, { readOnlyHint: true, idempotentHint: true }],
    [IDEMPOTENT_WRITE, { readOnlyHint: false, idempotentHint: true }],
    [WRITE, { readOnlyHint: false, idempotentHint: false }],
    [DESTRUCTIVE, { readOnlyHint: false, destructiveHint: true, idempotentHint: false }],
    [SPENDS_MONEY, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }],
    [OPEN_WORLD, { openWorldHint: true }],
  ];
  for (const [preset, value] of expected) {
    assert.deepEqual(preset, value);
    assert.equal(Object.isFrozen(preset), true);
    assert.doesNotThrow(() => assertAnnotations(preset));
  }
});

test('annotations: missing, empty and invalid annotations never register', () => {
  let calls = 0;
  const server = { registerTool() { calls++; } };
  const invalid = [
    undefined, null, {}, [], true, 'read', { title: 'Display only' },
    { readOnlyHint: 'true' }, { readOnlyHint: undefined },
    { readOnlyHint: true, idempotentHint: null },
    { readOnlyHint: true, title: 2 }, { readOnlyHint: true, readOnly: true },
    Object.create({ readOnlyHint: true }),
  ];
  for (const annotations of invalid) {
    assert.throws(() => registerTool(server, 'test', { annotations }, () => null), TypeError);
  }
  assert.throws(() => registerTool(server, 'test', {}, () => null), TypeError);
  assert.equal(calls, 0);
});

test('annotations: registration preserves receiver, config, callback and return value', async () => {
  const returned = { disable() {} };
  const callback = async (input) => ({ content: [{ type: 'text', text: input.name }] });
  const config = { title: 'Read', annotations: { ...READ_ONLY, ...OPEN_WORLD }, inputSchema: {} };
  const server = {
    registrations: [],
    registerTool(name, actualConfig, actualCallback) {
      assert.equal(this, server);
      this.registrations.push({ name, config: actualConfig, callback: actualCallback });
      return returned;
    },
  };
  assert.equal(registerTool(server, 'read', config, callback), returned);
  assert.deepEqual(server.registrations, [{ name: 'read', config, callback }]);
  assert.equal(server.registrations[0].config, config);
  assert.equal(server.registrations[0].callback, callback);
  assert.deepEqual(await server.registrations[0].callback({ name: 'kept' }), {
    content: [{ type: 'text', text: 'kept' }],
  });
});

test('annotations: structural generic registration keeps types and rejects missing hints', () => {
  const virtualPath = fileURLToPath(new URL('./annotations-typecheck.ts', import.meta.url));
  const source = `
    import { registerTool, READ_ONLY } from '../src/annotations.js';
    type Schema<T> = { output: T };
    type Shape = Record<string, Schema<unknown>>;
    type Args<S extends Shape> = { [K in keyof S]: S[K]['output'] };
    declare const server: {
      registerTool<S extends Shape>(name: string, config: { inputSchema: S; annotations?: { readOnlyHint?: boolean } }, callback: (input: Args<S>) => Promise<{ text: string }>): { disable(): void };
    };
    const result = registerTool(server, 'read', { annotations: READ_ONLY, inputSchema: { count: { output: 1 } } }, async (input: { count: number }) => ({ text: String(input.count) }));
    result.disable();
    // @ts-expect-error Registered return retains its original type.
    result.missing();
    // @ts-expect-error Callback must agree with the schema.
    registerTool(server, 'bad', { annotations: READ_ONLY, inputSchema: { count: { output: 1 } } }, async (input: { count: string }) => ({ text: input.count }));
    // @ts-expect-error Annotations are mandatory.
    registerTool(server, 'bad', { inputSchema: {} }, async () => ({ text: '' }));
    // @ts-expect-error Empty annotations are not a policy.
    registerTool(server, 'bad', { annotations: {}, inputSchema: {} }, async () => ({ text: '' }));
    // @ts-expect-error Annotation hints are booleans.
    registerTool(server, 'bad', { annotations: { readOnlyHint: 'yes' }, inputSchema: {} }, async () => ({ text: '' }));
  `;
  const options = {
    strict: true, noEmit: true, skipLibCheck: true, types: [],
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (path, ...args) => path === virtualPath
    ? ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true)
    : getSourceFile(path, ...args);
  const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([virtualPath], options, host));
  assert.equal(diagnostics.length, 0, ts.formatDiagnostics(diagnostics, {
    getCurrentDirectory: () => process.cwd(), getCanonicalFileName: (path) => path, getNewLine: () => '\n',
  }));
});

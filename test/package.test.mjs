import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));

test('package exports exactly five built entry points with no runtime dependencies', async () => {
  assert.deepEqual(Object.keys(pkg.exports).sort(), ['./annotations', './conformance', './http', './ledger', './results']);
  assert.equal(pkg.name, '@auny/mcp-core');
  assert.equal(pkg.version, '0.1.0');
  assert.equal(pkg.license, 'MIT');
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
  assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ['@cloudflare/workers-types', 'typescript']);
  assert.match(readFileSync(new URL('LICENSE', root), 'utf8'), /AunySillyMe/);
  for (const [path, target] of Object.entries(pkg.exports)) {
    assert.ok(readFileSync(new URL(target.types, root), 'utf8').length > 0);
    assert.ok(Object.keys(await import(`@auny/mcp-core/${path.slice(2)}`)).length > 0);
  }
});

test('package Worker adapter and mixin typecheck with real platform types', () => {
  const virtual = fileURLToPath(new URL('test/worker-typecheck.ts', root));
  const source = `
    import { DurableObject } from 'cloudflare:workers';
    import { CodeLedger as Shared, makeCodeLedger, claimAuthCode } from '@auny/mcp-core/ledger';
    interface Env { marker: string }
    export class NamedLedger extends Shared<Env> {
      marker() { return this.env.marker; }
    }
    export class MixedLedger extends makeCodeLedger(DurableObject<Env>) {
      marker() { return this.env.marker; }
    }
    declare const direct: DurableObjectNamespace<NamedLedger>;
    declare const mixed: DurableObjectNamespace<MixedLedger>;
    const first: Promise<boolean> = claimAuthCode(direct, 'fixture', 100);
    const second: Promise<boolean> = claimAuthCode(mixed, 'fixture', 100);
    // @ts-expect-error The inherited environment remains typed.
    new NamedLedger({} as DurableObjectState, { marker: 123 });
  `;
  const options = {
    strict: true, noEmit: true, skipLibCheck: true,
    types: ['@cloudflare/workers-types'], lib: ['lib.es2022.d.ts'],
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, customConditions: ['workerd'],
  };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (path, ...args) => path === virtual
    ? ts.createSourceFile(path, source, options.target, true) : original(path, ...args);
  const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([virtual], options, host));
  assert.equal(diagnostics.length, 0, ts.formatDiagnostics(diagnostics, {
    getCurrentDirectory: () => process.cwd(), getCanonicalFileName: x => x, getNewLine: () => '\n',
  }));
});

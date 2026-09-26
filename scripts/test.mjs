import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
// Node options must precede file names, including options forwarded by npm.
const files = readdirSync(new URL('../test/', import.meta.url))
  .filter(name => name.endsWith('.test.mjs')).sort().map(name => `test/${name}`);
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], {
  stdio: 'inherit', cwd: new URL('../', import.meta.url),
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

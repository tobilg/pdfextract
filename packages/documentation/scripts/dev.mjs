import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const cwd = fileURLToPath(new URL('../', import.meta.url));
const children = new Set();
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
}
function start(command, args, restart = false) {
  const child = spawn(process.execPath, [command, ...args], {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, TYPEDOC_FORCE_WATCH: '1' },
  });
  children.add(child);
  child.on('error', (error) => {
    console.error(error);
    stop(1);
  });
  child.on('exit', (code) => {
    children.delete(child);
    if (!stopping && restart && code === 7) start(command, args, true);
    else if (!stopping) stop(code ?? 1);
  });
}
// Invoke the CLI directly to own the watcher process; TypeDoc's wrapper otherwise forks.
start(resolve(dirname(require.resolve('typedoc')), 'cli.js'), ['--watch'], true);
start(resolve(dirname(require.resolve('vite/package.json')), 'bin/vite.js'), [
  'dist',
  '--host',
  '127.0.0.1',
  '--port',
  '4174',
  '--strictPort',
]);
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

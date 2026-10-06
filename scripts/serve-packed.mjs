import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const { directory } = JSON.parse(await readFile('artifacts/consumer.json', 'utf8'));
const child = spawn(
  'pnpm',
  [
    'exec',
    'vite',
    'preview',
    'browser',
    '--config',
    'browser/vite.config.ts',
    '--host',
    '127.0.0.1',
    '--port',
    '4173',
    '--strictPort',
  ],
  { cwd: directory, stdio: 'inherit' },
);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});

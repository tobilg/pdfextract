import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const { directory } = JSON.parse(await readFile('artifacts/consumer.json', 'utf8'));
for (const args of [['smoke.mjs'], ['--test', 'filesystem.mjs']]) {
  const result = spawnSync(process.execPath, args, { cwd: directory, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

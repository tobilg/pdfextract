import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { build } from 'vite';

await build({
  configFile: false,
  build: {
    ssr: 'scripts/benchmark.ts',
    outDir: 'artifacts/benchmark',
    rollupOptions: {
      external: (id) => !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('\0'),
      output: { entryFileNames: 'benchmark.mjs' },
    },
  },
});
const result = spawnSync(
  process.execPath,
  ['--expose-gc', resolve('artifacts/benchmark/benchmark.mjs')],
  { stdio: 'inherit' },
);
process.exitCode = result.status ?? 1;

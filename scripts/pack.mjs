import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PUBLIC_PACKAGES } from './packages.mjs';

const root = process.cwd(),
  artifacts = resolve('artifacts');
await mkdir(artifacts, { recursive: true });
function run(command, args, cwd = root) {
  const r = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${command} exited ${r.status}`);
}
for (const name of PUBLIC_PACKAGES)
  run('pnpm', ['--dir', `packages/${name}`, 'pack', '--pack-destination', artifacts]);
const versions = Object.fromEntries(
  await Promise.all(
    PUBLIC_PACKAGES.map(async (name) => [
      name,
      JSON.parse(await readFile(`packages/${name}/package.json`, 'utf8')).version,
    ]),
  ),
);
const consumer = await mkdtemp(join(await realpath(tmpdir()), 'pdfextract-consumer-'));
const deps = Object.fromEntries(
  PUBLIC_PACKAGES.map((name) => [
    `@pdfextract/${name}`,
    `file:${join(artifacts, `pdfextract-${name}-${versions[name]}.tgz`)}`,
  ]),
);
await writeFile(
  join(consumer, 'package.json'),
  JSON.stringify({
    name: 'clean-pdfextract-consumer',
    private: true,
    type: 'module',
    dependencies: { ...deps, '@aws-sdk/client-s3': '3.1146.0' },
    devDependencies: {
      typescript: '6.0.3',
      vite: '8.3.3',
      '@types/node': '22.19.1',
      '@playwright/test': '1.63.0',
    },
  }),
);
await writeFile(join(consumer, 'pnpm-workspace.yaml'), 'allowBuilds:\n  tesseract.js: false\n');
run('pnpm', ['install'], consumer);
await cp('tests/packaging/smoke.mjs', join(consumer, 'smoke.mjs'));
await cp('tests/packaging/consumer.ts', join(consumer, 'consumer.ts'));
await cp('tests/fixtures/baseline.pdf', join(consumer, 'baseline.pdf'));
await cp('tests/fixtures/scan.pdf', join(consumer, 'scan.pdf'));
await cp('tests/packaging/filesystem.mjs', join(consumer, 'filesystem.mjs'));
await cp('tests/packaging/isolation-loader.mjs', join(consumer, 'isolation-loader.mjs'));
await mkdir(join(consumer, 'languages'), { recursive: true });
await cp(
  'node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz',
  join(consumer, 'languages/eng.traineddata.gz'),
);
await writeFile(
  join(consumer, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: {
      strict: true,
      skipLibCheck: true,
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      lib: ['ES2023', 'DOM'],
      types: ['node'],
      noEmit: true,
    },
    include: ['consumer.ts'],
  }),
);
run('pnpm', ['exec', 'tsc'], consumer);
run(process.execPath, ['smoke.mjs'], consumer);
run(process.execPath, ['--test', 'filesystem.mjs'], consumer);
run(
  process.execPath,
  [
    '--loader',
    './isolation-loader.mjs',
    '--input-type=module',
    '-e',
    "await import('@pdfextract/storage/filesystem')",
  ],
  consumer,
);
if (process.env.PDFEXTRACT_NODE22) run(process.env.PDFEXTRACT_NODE22, ['smoke.mjs'], consumer);
await cp('examples/browser', join(consumer, 'browser'), {
  recursive: true,
  filter: (src) => !src.includes('/public') && !src.includes('/dist'),
});
await cp('examples/shared', join(consumer, 'shared'), { recursive: true });
await writeFile(
  join(consumer, 'tsconfig.browser.json'),
  JSON.stringify({
    compilerOptions: {
      strict: true,
      skipLibCheck: true,
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      lib: ['ES2023', 'DOM', 'DOM.Iterable'],
      types: ['vite/client'],
      noEmit: true,
    },
    include: ['browser/main.ts', 'browser/demo-storage.ts', 'shared/**/*.ts'],
  }),
);
run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.browser.json'], consumer);
await mkdir(join(consumer, 'browser/public/pdfextract'), { recursive: true });
for (const name of ['core', 'ocr'])
  await cp(
    join(consumer, `node_modules/@pdfextract/${name}/dist/assets`),
    join(consumer, `browser/public/pdfextract/${name}`),
    { recursive: true },
  );
await cp(
  'examples/browser/public/pdfextract/languages',
  join(consumer, 'browser/public/pdfextract/languages'),
  { recursive: true },
);
run('pnpm', ['exec', 'vite', 'build', 'browser', '--config', 'browser/vite.config.ts'], consumer);
await writeFile(
  join(artifacts, 'consumer.json'),
  JSON.stringify(
    {
      directory: consumer,
      node: process.version,
      nodeMinimumTested: process.env.PDFEXTRACT_NODE22 ?? null,
    },
    null,
    2,
  ),
);
console.log(`Packed consumer ready: ${consumer}`);

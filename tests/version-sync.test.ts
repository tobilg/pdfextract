import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { temporaryDirectory } from './helpers/temp.js';

const script = resolve('scripts/sync-versions.mjs');
const names = ['core', 'ocr', 'storage', 'documentation', 'demo'];
let directory: string;
const file = (name: string) => join(directory, 'packages', name, 'package.json');
const snapshot = () => Promise.all(names.map((name) => readFile(file(name), 'utf8')));
const sync = (...args: string[]) =>
  spawnSync(process.execPath, [script, ...args], { cwd: directory, encoding: 'utf8' });

beforeEach(async () => {
  directory = await temporaryDirectory('pdfextract-version-sync-');
  for (const name of names) {
    await mkdir(join(directory, 'packages', name), { recursive: true });
    await writeFile(
      file(name),
      JSON.stringify({
        name: `@pdfextract/${name}`,
        version: name === 'core' ? '1.2.3' : '0.1.0',
        private: ['documentation', 'demo'].includes(name),
        license: 'UNLICENSED',
        ...(name !== 'core' && {
          peerDependencies: { '@pdfextract/core': '^0.1.0', 'external-peer': '^7.0.0' },
          devDependencies: { '@pdfextract/core': 'workspace:*', 'external-dep': '6.4.0' },
        }),
      }),
    );
  }
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test.each([
  { args: [], target: '1.2.3' },
  { args: ['2.3.4'], target: '2.3.4' },
])('synchronizes package and peer versions to $target', async ({ args, target }) => {
  const result = sync(...args);
  expect(result.status, result.stderr).toBe(0);
  for (const name of names) {
    const manifest = JSON.parse(await readFile(file(name), 'utf8'));
    expect(manifest.version).toBe(target);
    expect(manifest.private).toBe(['documentation', 'demo'].includes(name));
    expect(manifest.license).toBe('UNLICENSED');
    if (name !== 'core') {
      expect(manifest.peerDependencies).toEqual({
        '@pdfextract/core': `^${target}`,
        'external-peer': '^7.0.0',
      });
      expect(manifest.devDependencies).toEqual({
        '@pdfextract/core': 'workspace:*',
        'external-dep': '6.4.0',
      });
    }
  }
  expect(sync('--check').status).toBe(0);
  const before = await snapshot();
  expect(sync().status).toBe(0);
  expect(await snapshot()).toEqual(before);
});

test('check detects drift without writing and dry-run previews an explicit version', async () => {
  const before = await snapshot();
  const result = sync('--check');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('not synchronized');
  expect(sync('2.3.4', '--dry-run').stdout).toContain('→ 2.3.4');
  expect(await snapshot()).toEqual(before);
});

test('check detects a stale internal peer even when all package versions match', async () => {
  expect(sync().status).toBe(0);
  const ocr = JSON.parse(await readFile(file('ocr'), 'utf8'));
  ocr.peerDependencies['@pdfextract/core'] = '^0.1.0';
  await writeFile(file('ocr'), JSON.stringify(ocr));
  expect(sync('--check').status).toBe(1);
  expect(sync().status).toBe(0);
  expect(sync('--check').status).toBe(0);
});

test.each(['v1.2.3', '1.2', '01.2.3', '1.2.3-beta.1', '1.2.3+build.1', '--unknown'])(
  'rejects %s before changing manifests',
  async (argument) => {
    const before = await snapshot();
    expect(sync(argument).status).not.toBe(0);
    expect(await snapshot()).toEqual(before);
  },
);

test('validates every package before changing any version', async () => {
  await writeFile(file('demo'), '{');
  const before = await snapshot();
  expect(sync('2.3.4').status).not.toBe(0);
  expect(await snapshot()).toEqual(before);
});

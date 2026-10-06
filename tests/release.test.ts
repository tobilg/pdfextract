import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { temporaryDirectory } from './helpers/temp.js';

const script = resolve('scripts/release.mjs');
let directory: string;

beforeEach(async () => {
  directory = await temporaryDirectory('pdfextract-release-test-');
  for (const name of ['core', 'ocr', 'storage', 'documentation', 'demo']) {
    await mkdir(join(directory, 'packages', name), { recursive: true });
    await writeFile(
      join(directory, 'packages', name, 'package.json'),
      JSON.stringify({
        name: `@pdfextract/${name}`,
        version: '1.2.3',
        private: ['documentation', 'demo'].includes(name),
        // Fictional package metadata for this isolated test; no repository license change.
        license: 'MIT',
        repository: { url: 'git+https://github.com/tobilg/pdfextract.git' },
      }),
    );
  }
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function check(refType = 'tag', refName = 'v1.2.3', dryRun = false) {
  return spawnSync(process.execPath, [script], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_REF_TYPE: refType,
      GITHUB_REF_NAME: refName,
      GITHUB_OUTPUT: join(directory, 'output'),
      RELEASE_DRY_RUN: String(dryRun),
    },
  });
}

async function update(name: string, changes: Record<string, unknown>) {
  const file = join(directory, 'packages', name, 'package.json');
  await writeFile(
    file,
    JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), ...changes }),
  );
}

describe('release eligibility before verification/publication', () => {
  test('accepts an exact stable tag and emits only the three public package names', async () => {
    const result = check();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      version: '1.2.3',
      dry_run: 'false',
      packages: 'core ocr storage',
    });
    expect(await readFile(join(directory, 'output'), 'utf8')).toContain('version=1.2.3\n');
  });

  test.each(['v1', 'v1.2', 'v1.2.3-beta.1', 'v1.2.3+build.1', 'release/v1.2.3', 'v1.2.3suffix'])(
    'rejects unsupported tag %s',
    (tag) => {
      const result = check('tag', tag);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('form vX.X.X');
    },
  );

  test('rejects prerelease package versions even in dry runs', async () => {
    await update('core', { version: '1.2.3-beta.1' });
    const result = check('branch', 'main', true);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('stable X.Y.Z');
  });

  test('rejects a well-formed tag for a different version', () => {
    const result = check('tag', 'v1.2.4');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('tag must match v1.2.3');
  });

  test('rejects branch publication while allowing local eligibility dry runs', () => {
    expect(check('branch', 'main').status).not.toBe(0);
    expect(check('branch', 'main', true).status).toBe(0);
  });

  test('rejects an unresolved owner license', async () => {
    await update('core', { license: 'UNLICENSED' });
    const result = check();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Owner package license is unresolved');
  });

  test('rejects version drift and public website workspaces', async () => {
    await update('ocr', { version: '1.2.4' });
    expect(check().stderr).toContain('All three library versions must match');
    await update('ocr', { version: '1.2.3' });
    await update('demo', { private: false });
    expect(check().stderr).toContain('The demo workspace must be private');
  });
});

test.each(['process.exit(7)', "process.kill(process.pid, 'SIGTERM')"])(
  'minimum-runtime verification fails closed when a consumer stops: %s',
  async (source) => {
    await mkdir(join(directory, 'artifacts'));
    await writeFile(join(directory, 'artifacts', 'consumer.json'), JSON.stringify({ directory }));
    await writeFile(join(directory, 'smoke.mjs'), source);
    // This would pass if a killed smoke process were accidentally treated as success.
    await writeFile(join(directory, 'filesystem.mjs'), '');
    const result = spawnSync(process.execPath, [resolve('scripts/minimum-consumer.mjs')], {
      cwd: directory,
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
  },
);

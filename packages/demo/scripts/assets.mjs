import { spawnSync } from 'node:child_process';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const destination = fileURLToPath(new URL('../public/pdfextract/', import.meta.url));
await rm(destination, { recursive: true, force: true });
const result = spawnSync(process.execPath, ['scripts/copy-assets.mjs', destination], {
  cwd: root,
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const notices = fileURLToPath(new URL('../public/notices/', import.meta.url));
await rm(notices, { recursive: true, force: true });
await mkdir(notices, { recursive: true });
for (const name of ['core', 'ocr']) {
  await cp(join(root, 'packages', name, 'THIRD_PARTY_NOTICES'), join(notices, name), {
    recursive: true,
  });
}
const require = createRequire(new URL('../package.json', import.meta.url));
for (const name of ['react', 'react-dom']) {
  await cp(join(dirname(require.resolve(name)), 'LICENSE'), join(notices, `${name}-LICENSE`));
}
const reactRequire = createRequire(require.resolve('react-dom'));
await cp(
  join(dirname(reactRequire.resolve('scheduler')), 'LICENSE'),
  join(notices, 'scheduler-LICENSE'),
);
await writeFile(
  join(notices, 'README.txt'),
  'Runtime notices: react-LICENSE, react-dom-LICENSE, scheduler-LICENSE, core/ and ocr/.\nCodec/font notices also accompany pdfextract/core/ and pdfextract/ocr/ assets.\nLanguage model provenance: ../pdfextract/languages/MODEL-SOURCES.txt.\nThe pdfextract owner license is unresolved; this is a local prerelease build.\n',
);

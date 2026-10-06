import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// Refreshes the license files under packages/*/THIRD_PARTY_NOTICES. The INVENTORY.md files
// are maintained by hand. Native OCR library notices need the tesseract.js-core submodule:
//   git submodule update --init vendor/tesseract.js-core
//   git -C vendor/tesseract.js-core submodule update --init

const require = createRequire(import.meta.url);
async function copy(target, name, source) {
  await mkdir(`packages/${target}/THIRD_PARTY_NOTICES`, { recursive: true });
  await cp(source, `packages/${target}/THIRD_PARTY_NOTICES/${name}`);
}
for (const target of ['core', 'ocr']) {
  const png = dirname(require.resolve('fast-png/package.json'));
  for (const name of ['fast-png', 'iobuffer', 'pako']) {
    const dir =
      name === 'fast-png'
        ? png
        : dirname(createRequire(join(png, 'package.json')).resolve(`${name}/package.json`));
    const file = (await readdir(dir)).find((f) => /^licen[cs]e(?:\.|$)/i.test(f));
    if (!file) throw new Error(`Missing ${name} notice`);
    await copy(target, `${name}-LICENSE`, join(dir, file));
  }
}
await copy('core', 'PDFJS-LICENSE', 'node_modules/pdfjs-dist/LICENSE');
const tesseract = dirname(require.resolve('tesseract.js/package.json'));
const tesseractRequire = createRequire(join(tesseract, 'package.json'));
await copy('ocr', 'TESSERACT-JS-LICENSE', join(tesseract, 'LICENSE.md'));
await copy(
  'ocr',
  'TESSERACT-JS-CORE-LICENSE',
  join(dirname(tesseractRequire.resolve('tesseract.js-core/package.json')), 'LICENSE'),
);
// Small tesseract.js dependencies bundled into the shipped OCR worker scripts
// (our Node bundles and upstream's browser worker.min.js).
for (const [name, file] of [
  ['bmp-js', 'LICENSE'],
  ['idb-keyval', 'LICENCE'],
  ['is-url', 'LICENSE-MIT'],
  ['regenerator-runtime', 'LICENSE'],
  ['wasm-feature-detect', 'LICENSE'],
  ['zlibjs', 'LICENSE'],
])
  await copy(
    'ocr',
    `${name}-LICENSE`,
    join(dirname(tesseractRequire.resolve(`${name}/package.json`)), file),
  );
const native = {
  tesseract: 'LICENSE',
  leptonica: 'leptonica-license.txt',
  libjpeg: 'README',
  libpng: 'LICENSE',
  libtiff: 'COPYRIGHT',
  libwebp: 'COPYING',
  zlib: 'README',
  giflib: 'COPYING',
  openlibm: 'LICENSE.md',
};
for (const [name, file] of Object.entries(native))
  await copy('ocr', `${name}-LICENSE`, `vendor/tesseract.js-core/third_party/${name}/${file}`);
await copy('storage', 'AWS-SDK-LICENSE', 'node_modules/@aws-sdk/client-s3/LICENSE');
// Guard: no AGPL-licensed package anywhere in the installed workspace.
const listed = spawnSync('pnpm', ['licenses', 'list', '--json'], {
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024,
});
if (listed.status) throw new Error(listed.stderr);
const agpl = Object.values(JSON.parse(listed.stdout))
  .flat()
  .filter((p) => /AGPL/i.test(p.license));
if (agpl.length) throw new Error(`Excluded AGPL dependencies: ${agpl.map((p) => p.name)}`);
console.log('Copied third-party notices; no AGPL dependency is installed.');

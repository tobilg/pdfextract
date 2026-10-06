import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';

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
await copy('core', 'CANVAS-LICENSE', 'vendor/canvas/LICENSE');
await copy('core', 'SKIA-LICENSE', 'vendor/canvas/skia/LICENSE');
await copy('ocr', 'TESSERACT-JS-LICENSE', 'vendor/tesseract.js/LICENSE.md');
await copy('ocr', 'TESSERACT-JS-CORE-LICENSE', 'vendor/tesseract.js-core/LICENSE');
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
const listed = spawnSync('pnpm', ['licenses', 'list', '--json'], {
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024,
});
if (listed.status) throw new Error(listed.stderr);
const packages = Object.values(JSON.parse(listed.stdout))
  .flat()
  .map((p) => ({
    name: p.name,
    versions: p.versions,
    license: p.license,
    homepage: p.homepage,
    paths: p.paths?.map((path) => relative(process.cwd(), path)),
  }))
  .sort((a, b) => a.name.localeCompare(b.name));
for (const p of packages) {
  if (p.license === 'Unknown' && ['humanize-number', 'only'].includes(p.name))
    p.license = 'MIT (full license in installed Readme.md)';
  if (/AGPL/i.test(p.license)) throw new Error(`Excluded dependency ${p.name}`);
}
await writeFile('docs/dependency-licenses.json', `${JSON.stringify(packages, null, 2)}\n`);
const sources = spawnSync('git', ['submodule', 'status', '--recursive'], { encoding: 'utf8' });
await writeFile('docs/upstream-commits.txt', sources.stdout);
const inventory = await readFile('docs/licenses.md', 'utf8');
for (const target of ['core', 'ocr', 'storage'])
  await writeFile(`packages/${target}/THIRD_PARTY_NOTICES/INVENTORY.md`, inventory);
console.log('Copied engine/codec notices and recorded installed dependency licenses.');

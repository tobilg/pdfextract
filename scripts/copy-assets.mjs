import { cp, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const target = resolve(process.argv[2] ?? 'examples/browser/public/pdfextract');
await mkdir(target, { recursive: true });
for (const name of ['core', 'ocr'])
  await cp(resolve(`node_modules/@pdfextract/${name}/dist/assets`), `${target}/${name}`, {
    recursive: true,
  });
await mkdir(`${target}/languages`, { recursive: true });
for (const language of ['eng', 'deu'])
  await cp(
    resolve(`node_modules/@tesseract.js-data/${language}/4.0.0/${language}.traineddata.gz`),
    `${target}/languages/${language}.traineddata.gz`,
  );
await cp(
  'packages/ocr/THIRD_PARTY_NOTICES/tesseract-LICENSE',
  `${target}/languages/LICENSE-APACHE-2.0`,
);
await writeFile(
  `${target}/languages/MODEL-SOURCES.txt`,
  'Models: @tesseract.js-data/eng@1.0.0 and @tesseract.js-data/deu@1.0.0, 4.0.0/*.traineddata.gz.\nUnderlying tessdata: Apache-2.0; https://github.com/tesseract-ocr/tessdata/blob/4.0.0/COPYING\nThe npm wrapper metadata declares MIT; wrapper JavaScript is not copied here.\n',
);
console.log(`Self-hosted assets copied to ${target}`);

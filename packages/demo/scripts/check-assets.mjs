import assert from 'node:assert/strict';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const files = [];
for (const file of await readdir(dist, { recursive: true })) {
  const info = await stat(join(dist, file));
  if (info.isFile()) {
    assert(info.size <= 25 * 1024 * 1024, `Asset exceeds the Pages 25 MiB limit: ${file}`);
    files.push({ file, bytes: info.size });
  }
}
assert(files.length <= 20_000, 'Static site exceeds the Pages free-plan file limit');
for (const file of [
  'index.html',
  '_headers',
  'pdfextract/core/pdf.mjs',
  'pdfextract/core/pdf.worker.mjs',
  'pdfextract/core/png.mjs',
  'pdfextract/ocr/worker.min.js',
  'pdfextract/ocr/tesseract.mjs',
  'pdfextract/languages/eng.traineddata.gz',
  'pdfextract/languages/deu.traineddata.gz',
  'pdfextract/languages/LICENSE-APACHE-2.0',
  'notices/react-LICENSE',
  'notices/react-dom-LICENSE',
  'notices/scheduler-LICENSE',
  'notices/core/PDFJS-LICENSE',
  'notices/ocr/tesseract-LICENSE',
])
  assert(
    files.some((entry) => entry.file === file),
    `Missing runtime asset: ${file}`,
  );
console.log(
  `Pages artifact: ${files.length} files; largest ${Math.max(...files.map((f) => f.bytes))} bytes`,
);

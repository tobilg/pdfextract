import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPdf } from '@pdfextract/core';
import { createTesseractOcr } from '@pdfextract/ocr';
import { createFilesystemStorage } from '@pdfextract/storage/filesystem';
import { createS3Storage } from '@pdfextract/storage/s3';

// Native text, embedded images and automatic region OCR must not need a native addon.
process.dlopen = () => {
  throw new Error('PACK-02: native addon loaded outside page rendering');
};
for (const name of ['core', 'ocr', 'storage']) {
  assert.ok(
    (await readFile(new URL(`./node_modules/@pdfextract/${name}/README.md`, import.meta.url)))
      .length > 100,
  );
  assert.ok(
    (
      await readFile(
        new URL(
          `./node_modules/@pdfextract/${name}/THIRD_PARTY_NOTICES/INVENTORY.md`,
          import.meta.url,
        ),
      )
    ).length > 100,
  );
}
const bytes = await readFile(new URL('./baseline.pdf', import.meta.url)),
  pdf = await openPdf(bytes);
try {
  assert.match((await pdf.getStructuredText()).fullText, /Native café/);
  const images = await pdf.getImages();
  assert.equal(images.length, 2);
  const image = await pdf.extractImage(images[0].id);
  assert.equal(image.width, 2);
  await pdf.close();
  assert.equal(image.data[0], 137);
} finally {
  await pdf.close();
}
const ocr = createTesseractOcr({
  languages: ['eng'],
  assets: { languageDataBaseUrl: fileURLToPath(new URL('./languages/', import.meta.url)) },
});
const scan = await openPdf(await readFile(new URL('./scan.pdf', import.meta.url)), { ocr });
try {
  assert.match((await scan.getStructuredText()).fullText, /RASTER SENTINEL 7429/);
} finally {
  await scan.close();
  await ocr.close();
}
const root = await mkdtemp(join(await realpath(tmpdir()), 'pdfextract-pack-storage-')),
  storage = createFilesystemStorage({ directory: root });
try {
  await storage.put('source.pdf', bytes, {
    contentType: 'application/pdf',
    metadata: { test: 'packed' },
  });
  assert.deepEqual(
    Buffer.from(await new Response((await storage.get('source.pdf')).body).arrayBuffer()),
    bytes,
  );
  assert.equal(
    (await createFilesystemStorage({ directory: root }).head('source.pdf')).metadata.test,
    'packed',
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
const calls = [];
const client = {
  async send(command) {
    calls.push(command.constructor.name);
    if (command.constructor.name === 'CreateMultipartUploadCommand') return { UploadId: 'id' };
    return { ETag: 'etag' };
  },
};
await createS3Storage({ client, bucket: 'example' }).put('small.txt', new Uint8Array([1]));
assert.deepEqual(calls, [
  'CreateMultipartUploadCommand',
  'UploadPartCommand',
  'CompleteMultipartUploadCommand',
]);
console.log(`PACK-01/02/03 smoke passed on ${process.version}`);

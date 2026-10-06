import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { S3Client } from '@aws-sdk/client-s3';
import { openPdf } from '@pdfextract/core';
import { createTesseractOcr } from '@pdfextract/ocr';
import { createFilesystemStorage } from '@pdfextract/storage/filesystem';
import { createS3Storage } from '@pdfextract/storage/s3';

const S3rver = createRequire(import.meta.url)('s3rver') as typeof import('s3rver');
const directory = await mkdtemp(join(await realpath(tmpdir()), 'pdfextract-benchmark-'));
const server = new S3rver({
  directory: join(directory, 's3'),
  address: '127.0.0.1',
  port: 0,
  silent: true,
  configureBuckets: [{ name: 'assets', configs: [] }],
});
const address = await server.run();
const client = new S3Client({
  endpoint: `http://127.0.0.1:${address.port}`,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId: 'S3RVER', secretAccessKey: 'S3RVER' },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
const fs = createFilesystemStorage({ directory: join(directory, 'fs') });
const s3 = createS3Storage({ client, bucket: 'assets' });
const ocr = createTesseractOcr({
  languages: ['eng'],
  assets: { languageDataBaseUrl: resolve('node_modules/@tesseract.js-data/eng/4.0.0') },
});
const rows: Record<string, unknown>[] = [];
let peak = process.memoryUsage().rss;
const sample = setInterval(() => {
  peak = Math.max(peak, process.memoryUsage().rss);
}, 10);
async function measure<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now();
  const result = await fn();
  return [result, Math.round((performance.now() - start) * 100) / 100];
}
try {
  for (const name of ['150-pages', '40-megapixels', 'mixed']) {
    const bytes = await readFile(`tests/fixtures/${name}.pdf`);
    const [pdf, openMs] = await measure(() => openPdf(bytes, name === 'mixed' ? { ocr } : {}));
    try {
      const [text, nativeTextMs] = await measure(() => pdf.getStructuredText({ ocr: 'off' }));
      const [images, inventoryMs] = await measure(() => pdf.getImages());
      const row: Record<string, unknown> = {
        name,
        inputBytes: bytes.length,
        pages: pdf.pageCount,
        returnedTextPages: text.pages.length,
        images: images.map((i) => ({
          width: i.width,
          height: i.height,
          occurrences: i.occurrences.length,
        })),
        openMs,
        nativeTextMs,
        inventoryMs,
      };
      if (name === 'mixed') row.ocrAndMergeMs = (await measure(() => pdf.getStructuredText()))[1];
      if (images[0]) {
        const [full, fullExportMs] = await measure(() => pdf.extractImage(images[0].id));
        row.fullExportMs = fullExportMs;
        row.exportBytes = full.data.length;
        row.thumbnailMs = (
          await measure(() => pdf.extractImage(images[0].id, { maxWidth: 320, maxHeight: 240 }))
        )[1];
        row.filesystemUploadMs = (await measure(() => fs.put(`${name}.png`, full.data)))[1];
        row.s3MultipartUploadMs = (await measure(() => s3.put(`${name}.png`, full.data)))[1];
        if (name === '40-megapixels' && (full.width !== 8000 || full.height !== 5000))
          throw new Error('Benchmark downscaled');
      }
      rows.push(row);
    } finally {
      await pdf.close();
    }
  }
  await ocr.close();
  const repeated: Record<string, unknown>[] = [];
  const source = await readFile('tests/fixtures/large-small.pdf');
  for (let run = 1; run <= 10; run++) {
    const pdf = await openPdf(source);
    const [image] = await pdf.getImages();
    await pdf.extractImage(image.id);
    await pdf.close();
    globalThis.gc?.();
    await new Promise((r) => setTimeout(r, 25));
    const memory = process.memoryUsage();
    const handles = (process as unknown as { _getActiveHandles(): object[] })
      ._getActiveHandles()
      .map((h) => h.constructor.name);
    repeated.push({
      run,
      ...memory,
      workerMessagePorts: handles.filter((n) => n === 'MessagePort').length,
    });
  }
  const result = {
    timestamp: new Date().toISOString(),
    hardware: {
      cpu: cpus()[0].model,
      logicalCpus: cpus().length,
      ramBytes: totalmem(),
      platform: platform(),
      release: release(),
      arch: arch(),
      node: process.version,
    },
    peakSampledRssBytes: peak,
    processMaxRssKiB: process.resourceUsage().maxRSS,
    sampleIntervalMs: 10,
    garbageCollectionExposed: !!globalThis.gc,
    rows,
    repeated,
  };
  await mkdir('artifacts/benchmarks', { recursive: true });
  await writeFile(
    'artifacts/benchmarks/local-baseline.json',
    `${JSON.stringify(result, null, 2)}\n`,
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  clearInterval(sample);
  await ocr.close();
  client.destroy();
  await server.close();
  await rm(directory, { recursive: true, force: true });
}

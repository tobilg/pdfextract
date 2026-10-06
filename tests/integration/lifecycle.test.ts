import { readFile } from 'node:fs/promises';
import { type OcrProvider, openPdf, PdfExtractError } from '@pdfextract/core';
import { expect, it } from 'vitest';

it('CORE-04: real worker startup failure retains the original diagnostic and allows recovery', async () => {
  const bytes = await readFile('tests/fixtures/baseline.pdf');
  const workerUrl = new URL(
    `data:text/javascript,${encodeURIComponent('throw new Error("worker-startup-sentinel")')}`,
  );
  await expect(openPdf(bytes, { assets: { workerUrl } })).rejects.toMatchObject({
    code: 'UNSUPPORTED_PDF_FEATURE',
    cause: { name: 'Error', message: 'worker-startup-sentinel', stack: expect.any(String) },
  });
  await expect(
    openPdf(bytes, {
      assets: { workerUrl: new URL('./missing-pdfextract-worker.mjs', import.meta.url) },
    }),
  ).rejects.toMatchObject({
    code: 'UNSUPPORTED_PDF_FEATURE',
    cause: { code: 'ERR_MODULE_NOT_FOUND', stack: expect.any(String) },
  });
  const pdf = await openPdf(bytes);
  try {
    expect((await pdf.getStructuredText()).fullText).toContain('Native café');
  } finally {
    await pdf.close();
  }
});

it('CORE-04: real password failure/success and failed engine asset load', async () => {
  const bytes = await readFile('tests/fixtures/password.pdf');
  await expect(openPdf(bytes)).rejects.toMatchObject({ code: 'PASSWORD_REQUIRED' });
  await expect(openPdf(bytes, { password: 'wrong' })).rejects.toMatchObject({
    code: 'INVALID_PASSWORD',
  });
  const pdf = await openPdf(bytes, { password: 'fixture-pass' });
  try {
    expect((await pdf.getStructuredText()).fullText).toContain('PASSWORD SENTINEL');
  } finally {
    await pdf.close();
  }
  await expect(
    openPdf(bytes, { assets: { baseUrl: new URL('file:///missing-pdfextract-assets/') } }),
  ).rejects.toMatchObject({ code: 'UNSUPPORTED_PDF_FEATURE' });
});

it('PERF-02 CORE-04: cancellation rejects queued work and keeps caller/output buffers owned', async () => {
  const input = await readFile('tests/fixtures/large-small.pdf');
  const pdf = await openPdf(input);
  const [image] = await pdf.getImages();
  const cancel = new AbortController();
  const work = pdf.extractImage(image.id, { signal: cancel.signal });
  const queued = pdf.getStructuredText({ signal: cancel.signal });
  cancel.abort();
  await expect(work).rejects.toMatchObject({ code: 'ABORTED' });
  await expect(queued).rejects.toMatchObject({ code: 'ABORTED' });
  const full = await pdf.extractImage(image.id);
  const copy = full.data.slice();
  await pdf.close();
  expect(Buffer.from(full.data).equals(Buffer.from(copy))).toBe(true);
  expect(input[0]).toBe(37);
});

it('OCR-03/04: repeated occurrences survive merging and rotated image geometry is transformed', async () => {
  let closed = 0;
  const provider: OcrProvider = {
    async recognize() {
      return {
        text: 'SENTINEL',
        warnings: [],
        lines: [
          {
            text: 'SENTINEL',
            bbox: { x: 100, y: 100, width: 200, height: 50 },
            words: [
              {
                text: 'SENTINEL',
                bbox: { x: 100, y: 100, width: 200, height: 50 },
                confidence: 0.95,
              },
            ],
          },
        ],
      };
    },
    async close() {
      closed++;
    },
  };
  const pdf = await openPdf(await readFile('tests/fixtures/repeated-ocr.pdf'), { ocr: provider });
  try {
    const result = await pdf.getStructuredText({ pages: [2] });
    expect(result.fullText.match(/SENTINEL/g)).toHaveLength(2);
    const spans = result.pages[0].blocks.flatMap((b) => b.lines.flatMap((l) => l.spans));
    expect(spans.map((s) => s.bbox)).toContainEqual({ x: 45, y: 155, width: 30, height: 7.5 });
    expect(spans.map((s) => s.bbox)).toContainEqual({ x: 355, y: 355, width: 7.5, height: 30 });
  } finally {
    await pdf.close();
  }
  expect(closed).toBe(0);
  await provider.close();
});

it('OCR-02/04: collect mode preserves a failed region after a later region succeeds', async () => {
  let calls = 0;
  const ocr: OcrProvider = {
    async recognize() {
      if (++calls === 1) throw new PdfExtractError('OCR_FAILED', 'injected region failure');
      return {
        text: 'RECOVERED',
        warnings: [],
        lines: [
          {
            text: 'RECOVERED',
            bbox: { x: 10, y: 10, width: 100, height: 20 },
            words: [
              {
                text: 'RECOVERED',
                bbox: { x: 10, y: 10, width: 100, height: 20 },
                confidence: 0.9,
              },
            ],
          },
        ],
      };
    },
    async close() {},
  };
  const pdf = await openPdf(await readFile('tests/fixtures/repeated-ocr.pdf'), { ocr });
  try {
    const result = await pdf.getStructuredText({ pages: [2], errorMode: 'collect' });
    expect(result.status).toBe('partial');
    expect(result.pages[0].ocrStatus).toBe('partial');
    expect(result.warnings[0].code).toBe('OCR_FAILED');
    expect(result.fullText).toContain('RECOVERED');
  } finally {
    await pdf.close();
    await ocr.close();
  }
});

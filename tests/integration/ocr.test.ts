import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { openPdf } from '../../packages/core/dist/index-node.js';
import { createTesseractOcr } from '../../packages/ocr/dist/index.js';

const raster = {
  width: 32,
  height: 32,
  stride: 128,
  format: 'rgba8' as const,
  data: new Uint8Array(4096).fill(255),
};

it('OCR-04 CORE-04: missing local model fails, startup cancels, provider closes idempotently', async () => {
  const missing = createTesseractOcr({
    languages: ['eng'],
    assets: { languageDataBaseUrl: resolve('tests/fixtures/missing-models') },
  });
  await expect(missing.recognize(raster)).rejects.toMatchObject({ code: 'OCR_ASSET_UNAVAILABLE' });
  await missing.close();
  const provider = createTesseractOcr({
    languages: ['eng'],
    assets: { languageDataBaseUrl: resolve('node_modules/@tesseract.js-data/eng/4.0.0') },
  });
  const cancel = new AbortController();
  await expect(
    provider.recognize(raster, {
      signal: cancel.signal,
      onProgress() {
        cancel.abort();
      },
    }),
  ).rejects.toMatchObject({ code: 'ABORTED' });
  await provider.close();
  await provider.close();
});

it('OCR-04/05: actual German model and full-page OCR normalize page coordinates', async () => {
  const provider = createTesseractOcr({
    languages: ['deu'],
    assets: {
      languageDataBaseUrl: pathToFileURL(resolve('node_modules/@tesseract.js-data/deu/4.0.0')),
      coreBaseUrl: pathToFileURL(resolve('packages/ocr/dist/assets/core')),
    },
  });
  const pdf = await openPdf(await readFile('tests/fixtures/scan.pdf'), { ocr: provider });
  try {
    const result = await pdf.getStructuredText({ ocr: 'always' });
    expect(result.fullText).toContain('Deutsche Karte Berlin');
    const words = result.pages[0].blocks.flatMap((b) => b.lines.flatMap((l) => l.spans));
    const deutsche = words.find((w) => w.text === 'Deutsche');
    if (!deutsche) throw new Error('Expected German word missing');
    expect(deutsche.source).toBe('ocr');
    expect(deutsche.bbox.x).toBeGreaterThan(40);
    expect(deutsche.bbox.x).toBeLessThan(60);
    expect(deutsche.bbox.y).toBeGreaterThan(250);
    expect(deutsche.bbox.y).toBeLessThan(280);
  } finally {
    await pdf.close();
    await provider.close();
  }
});

it('OCR-01/02/03/04/05: actual local English OCR with mixed content and a hidden layer', async () => {
  const provider = createTesseractOcr({
    languages: ['eng'],
    assets: { languageDataBaseUrl: resolve('node_modules/@tesseract.js-data/eng/4.0.0') },
  });
  try {
    for (const name of ['scan', 'mixed', 'hidden']) {
      const pdf = await openPdf(await readFile(`tests/fixtures/${name}.pdf`), { ocr: provider });
      try {
        const result = await pdf.getStructuredText();
        expect(result.fullText).toContain('RASTER');
        expect(result.fullText).toContain('7429');
        if (name === 'mixed') expect(result.fullText).toContain('Native paragraph');
        if (name === 'hidden') expect(result.fullText.match(/7429/g)).toHaveLength(1);
        for (const block of result.pages[0].blocks) expect(block.bbox.y).toBeGreaterThanOrEqual(0);
      } finally {
        await pdf.close();
      }
    }
  } finally {
    await provider.close();
    await provider.close();
  }
});

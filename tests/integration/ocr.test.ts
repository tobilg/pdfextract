import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { expect, it } from 'vitest';
import { openPdf } from '../../packages/core/dist/index-node.js';
import { createTesseractOcr } from '../../packages/ocr/dist/index-node.js';
import { pdfWithImage } from '../helpers/pdf.js';

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

it('OCR-04: concurrency defaults to half the logical processors, one to four', async () => {
  const provider = createTesseractOcr({ languages: ['eng'] });
  const cores = navigator.hardwareConcurrency;
  expect(provider.concurrency).toBe(Math.max(1, Math.min(4, Math.floor(cores / 2))));
  expect(createTesseractOcr({ languages: ['eng'], concurrency: 1 }).concurrency).toBe(1);
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

it('OCR-07: a scanned two-column page with a full-width heading reads column by column', async () => {
  // A 150 DPI letter-size scan: aligned rows in two columns across a 24pt gutter.
  const dpi = 150,
    pt = dpi / 72,
    canvas = createCanvas(Math.round(8.5 * dpi), Math.round(11 * dpi)),
    context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#000';
  context.font = `bold ${16 * pt}px sans-serif`;
  context.fillText('Regional Logistics Review for the Third Quarter', 72 * pt, 90 * pt);
  context.font = `${11 * pt}px sans-serif`;
  const columns = [
    ['Alpha shipments from the northern hub', 'Bravo handling times fell sharply'],
    ['Charlie complaints about late vans', 'Delta savings came from new routes'],
  ];
  for (const [c, lines] of columns.entries())
    for (const [i, line] of lines.entries())
      context.fillText(line, (72 + c * 246) * pt, (130 + i * 15) * pt);
  const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data,
    rgb = new Uint8Array(canvas.width * canvas.height * 3);
  for (let i = 0; i < canvas.width * canvas.height; i++)
    rgb.set(rgba.subarray(i * 4, i * 4 + 3), i * 3);
  const provider = createTesseractOcr({
    languages: ['eng'],
    assets: { languageDataBaseUrl: resolve('node_modules/@tesseract.js-data/eng/4.0.0') },
  });
  // The helper's page is 600×800 pt; the scan fills it (about 150 DPI).
  const bytes = pdfWithImage('q 600 0 0 800 0 0 cm /I Do Q', canvas.width, canvas.height, rgb);
  try {
    for (const ocr of ['auto', 'always'] as const) {
      const pdf = await openPdf(bytes, { ocr: provider });
      try {
        const { fullText } = await pdf.getStructuredText({ ocr });
        expect(fullText).toMatch(/Regional[\s\S]*Alpha[\s\S]*Bravo[\s\S]*Charlie[\s\S]*Delta/);
      } finally {
        await pdf.close();
      }
    }
  } finally {
    await provider.close();
  }
});

it('OCR-08: coloured text on white panels of a dark image is recognized', async () => {
  // Green and blue text, as on infographics: Tesseract's per-channel thresholding of the colour
  // raster loses it, so the provider recognizes luminance.
  const width = 1200,
    height = 600,
    canvas = createCanvas(width, height),
    context = canvas.getContext('2d');
  context.fillStyle = '#232323';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#fff';
  context.fillRect(40, 60, 1120, 480);
  context.font = '30px sans-serif';
  context.fillStyle = '#3cb54a';
  context.fillText('Copyright protects creative work, so people', 80, 160);
  context.fillText('cannot share it without permission today.', 80, 210);
  context.fillStyle = '#29abe2';
  context.fillText('Facts and ideas are not protected by copyright,', 80, 360);
  context.fillText('neither are many government documents.', 80, 410);
  const rgba = context.getImageData(0, 0, width, height).data,
    rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) rgb.set(rgba.subarray(i * 4, i * 4 + 3), i * 3);
  const provider = createTesseractOcr({
    languages: ['eng'],
    assets: { languageDataBaseUrl: resolve('node_modules/@tesseract.js-data/eng/4.0.0') },
  });
  const pdf = await openPdf(pdfWithImage('q 480 0 0 240 60 500 cm /I Do Q', width, height, rgb), {
    ocr: provider,
  });
  try {
    const { fullText } = await pdf.getStructuredText({ ocr: 'auto' });
    expect(fullText).toMatch(/Copyright protects creative work[\s\S]*government documents/);
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

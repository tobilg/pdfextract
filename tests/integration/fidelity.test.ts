import { readFile } from 'node:fs/promises';
import { openPdf } from '@pdfextract/core';
import { decode } from 'fast-png';
import { expect, it } from 'vitest';

const fixture = (name: string) => readFile(`tests/fixtures/${name}.pdf`);
it('IMG-02: JPX lossless gradients, CCITT G4 and JBIG2 MMR retain independently known pixels', async () => {
  for (const name of ['jpx', 'ccitt', 'jbig2']) {
    const pdf = await openPdf(await fixture(name));
    try {
      const [image] = await pdf.getImages();
      const full = await pdf.extractImage(image.id);
      expect([full.width, full.height]).toEqual([64, 32]);
      const pixels = decode(full.data).data;
      for (let y = 0; y < 32; y++)
        for (let x = 0; x < 64; x++) {
          const bit = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 ? 255 : 0;
          const expected = name === 'jpx' ? [x * 4, y * 8, 127, 255] : [bit, bit, bit, 255];
          expect(Array.from(pixels.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4))).toEqual(
            expected,
          );
        }
    } finally {
      await pdf.close();
    }
  }
});
it('IMG-02: ICC/CMYK conversion agrees with independent LittleCMS reference (4/255 CMYK LUT, 2/255 RGB)', async () => {
  const reference = JSON.parse(await readFile('tests/fixtures/color-reference.json', 'utf8'));
  const pdf = await openPdf(await fixture('colors'));
  try {
    const images = await pdf.getImages();
    for (const [index, expected] of [
      [3, reference.cmyk],
      [7, reference.displayP3],
    ] as [number, number[]][]) {
      const pixels = decode((await pdf.extractImage(images[index].id)).data).data;
      let sample = 0;
      for (let i = 0; i < pixels.length; i++) {
        if (i % 4 !== 3) {
          expect(Math.abs(pixels[i] - expected[sample++])).toBeLessThanOrEqual(index === 3 ? 4 : 2);
        }
      }
    }
  } finally {
    await pdf.close();
  }
});
it('CORE-02: columns, empty page, CropBox, rotation and UserUnit', async () => {
  const pdf = await openPdf(await fixture('layout'));
  try {
    const text = await pdf.getStructuredText();
    expect(text.pages[0].fullText).toBe('LEFT FIRST\nLEFT SECOND\n\nRIGHT FIRST\nRIGHT SECOND');
    expect(text.pages[1].fullText).toBe('');
    expect([text.pages[2].width, text.pages[2].height, text.pages[2].rotation]).toEqual([
      1480, 1120, 90,
    ]);
    const b = text.pages[2].blocks[0].bbox;
    expect(b.x).toBeGreaterThan(1400);
    expect(b.y).toBeCloseTo(40);
    expect(b.x + b.width).toBeLessThan(1480);
  } finally {
    await pdf.close();
  }
});
it('IMG-02/05: visible stencil fill variants and reused identity', async () => {
  const pdf = await openPdf(await fixture('stencils'));
  try {
    const images = await pdf.getImages();
    expect(images).toHaveLength(2);
    expect(images[0].occurrences).toHaveLength(2);
    const red = decode((await pdf.extractImage(images[0].id)).data).data,
      blue = decode((await pdf.extractImage(images[1].id)).data).data;
    expect(Array.from(red)).toEqual([255, 0, 0, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255]);
    expect(Array.from(blue)).toEqual([0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255]);
  } finally {
    await pdf.close();
  }
});
it('IMG-02/03: page clipping and rotation do not crop or rotate the native export', async () => {
  const pdf = await openPdf(await fixture('clipped-rotated'));
  try {
    const [image] = await pdf.getImages();
    expect(image.occurrences).toHaveLength(2);
    expect(image.occurrences[0].clipped).toBe(true);
    const pixels = decode((await pdf.extractImage(image.id)).data).data;
    expect(Array.from(pixels)).toEqual([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255,
    ]);
    expect(image.occurrences[1].imageToPage).toEqual([0, -20, 10, 0, 80, 700]);
  } finally {
    await pdf.close();
  }
});
it('IMG-02: actual JPEG decoding meets the known solid-color expectation (2/255 codec tolerance)', async () => {
  const pdf = await openPdf(await fixture('jpeg'));
  try {
    const [image] = await pdf.getImages(),
      full = await pdf.extractImage(image.id),
      pixels = decode(full.data).data;
    expect([full.width, full.height]).toEqual([64, 32]);
    for (let i = 0; i < pixels.length; i += 4) {
      expect(Math.abs(pixels[i] - 40)).toBeLessThanOrEqual(2);
      expect(Math.abs(pixels[i + 1] - 120)).toBeLessThanOrEqual(2);
      expect(Math.abs(pixels[i + 2] - 200)).toBeLessThanOrEqual(2);
    }
  } finally {
    await pdf.close();
  }
});
it('PERF-02 IMG-02: excessive declarations and truncated rasters fail explicitly', async () => {
  for (const [name, code] of [
    ['excessive', 'RESOURCE_LIMIT_EXCEEDED'],
    ['malformed-image', 'UNSUPPORTED_IMAGE_FEATURE'],
  ]) {
    const pdf = await openPdf(await fixture(name));
    try {
      const [image] = await pdf.getImages();
      await expect(pdf.extractImage(image.id)).rejects.toMatchObject({ code });
    } finally {
      await pdf.close();
    }
  }
});

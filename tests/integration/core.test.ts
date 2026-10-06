import { readFile } from 'node:fs/promises';
import { decode } from 'fast-png';
import { describe, expect, it } from 'vitest';
import { openPdf } from '../../packages/core/dist/index-node.js';

const fixture = (name: string) => readFile(new URL(`../fixtures/${name}.pdf`, import.meta.url));
describe('real PDF engine', () => {
  it('CORE-01/02/03/04 IMG-02/03/04/05: whole inputs, Unicode, nested/inline/reused images and masks', async () => {
    const bytes = await fixture('baseline'),
      copy = new Uint8Array(bytes);
    for (const input of [
      bytes,
      new Uint8Array(bytes),
      new Uint8Array(bytes).buffer,
      new Blob([copy]),
      new File([copy], 'sample.pdf'),
    ]) {
      const pdf = await openPdf(input);
      const text = await pdf.getStructuredText();
      expect(text.fullText).toContain('Native café');
      expect(JSON.parse(JSON.stringify(text))).toEqual(text);
      const images = await pdf.getImages();
      expect(images).toHaveLength(2);
      expect(images[0].occurrences).toHaveLength(2);
      expect((await pdf.getImages({ pages: [2] }))[0].id).toBe(images[0].id);
      expect((await pdf.getImages({ pages: [2] }))[0].occurrences).toHaveLength(1);
      const full = await pdf.extractImage(images[0].id);
      const pixels = decode(full.data);
      expect([pixels.width, pixels.height]).toEqual([2, 2]);
      expect(Array.from(pixels.data)).toEqual([
        255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 255, 255, 0, 255,
      ]);
      const thumbnail = await pdf.extractImage(images[0].id, { maxWidth: 1, maxHeight: 1 });
      expect([thumbnail.width, thumbnail.height, thumbnail.variant]).toEqual([1, 1, 'thumbnail']);
      expect((await pdf.extractImage(images[0].id)).data).toEqual(full.data);
      await pdf.close();
      await pdf.close();
      expect(decode(full.data).data).toEqual(pixels.data);
      await expect(pdf.getImages()).rejects.toMatchObject({ code: 'DOCUMENT_CLOSED' });
    }
    expect(bytes).toEqual(Buffer.from(copy));
  });
  it('IMG-01: a 4096×2048 source drawn at 40×20 exports at native dimensions', async () => {
    const pdf = await openPdf(await fixture('large-small'));
    try {
      const [image] = await pdf.getImages();
      expect([image.width, image.height]).toEqual([4096, 2048]);
      expect(image.occurrences[0].bbox.width).toBe(40);
      const full = await pdf.extractImage(image.id);
      expect([decode(full.data).width, decode(full.data).height]).toEqual([4096, 2048]);
    } finally {
      await pdf.close();
    }
  });
  it('IMG-02: RGB, gray, indexed, CMYK, ICC, decode and color-key alpha', async () => {
    const pdf = await openPdf(await fixture('colors'));
    try {
      const images = await pdf.getImages();
      expect(images).toHaveLength(8);
      const pixels = [];
      for (const image of images)
        pixels.push(Array.from(decode((await pdf.extractImage(image.id)).data).data));
      expect(pixels[0]).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]);
      expect(pixels[1]).toEqual([
        0, 0, 0, 255, 64, 64, 64, 255, 128, 128, 128, 255, 255, 255, 255, 255,
      ]);
      expect(pixels[2]).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 255, 0, 0, 255]);
      expect(pixels[4]).toEqual(pixels[0]);
      expect(pixels[5]).toEqual([
        255, 255, 255, 255, 191, 191, 191, 255, 127, 127, 127, 255, 0, 0, 0, 255,
      ]);
      expect(pixels[6][3]).toBe(0);
    } finally {
      await pdf.close();
    }
  });
  it('PERF-01/02: 150 pages, limits and cancellation', async () => {
    const bytes = await fixture('150-pages');
    await expect(openPdf(bytes, { limits: { maxPages: 149 } })).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED',
    });
    const pdf = await openPdf(bytes);
    try {
      const text = await pdf.getStructuredText();
      expect(text.pages).toHaveLength(150);
      expect(text.pages[149].fullText).toBe('Page 150');
      const controller = new AbortController();
      await expect(
        pdf.getStructuredText({ signal: controller.signal, onProgress: () => controller.abort() }),
      ).rejects.toMatchObject({ code: 'ABORTED' });
      await expect(pdf.getImages({ pages: [0] })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
    } finally {
      await pdf.close();
    }
    await expect(openPdf(await fixture('corrupt'))).rejects.toMatchObject({ code: 'INVALID_PDF' });
  });
});

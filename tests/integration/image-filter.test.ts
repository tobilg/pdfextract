import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { openPdf } from '../../packages/core/dist/index-node.js';
import { pdfWithImage } from '../helpers/pdf.js';

const sizes = (images: readonly { width: number; height: number }[]) =>
  images.map((image) => `${image.width}x${image.height}`);

it('IMG-06: minimum image size filters the inventory and counts ignored images', async () => {
  // baseline.pdf: a 2×2 image on pages 1 and 2, and a 1×1 image on page 1.
  const pdf = await openPdf(await readFile('tests/fixtures/baseline.pdf'));
  try {
    const all = await pdf.getImages();
    expect(sizes(all)).toEqual(['2x2', '1x1']);
    expect(all.ignoredCount).toBe(0);

    const wide = await pdf.getImages({ minWidth: 2 });
    expect(sizes(wide)).toEqual(['2x2']);
    expect(wide.ignoredCount).toBe(1);

    const none = await pdf.getImages({ minWidth: 2, minHeight: 3 });
    expect(none).toHaveLength(0);
    expect(none.ignoredCount).toBe(2);

    // Only images on the selected pages are counted.
    const page2 = await pdf.getImages({ pages: [2], minWidth: 2 });
    expect(sizes(page2)).toEqual(['2x2']);
    expect(page2.ignoredCount).toBe(0);

    // Filtering is a view: a left-out image can still be exported by ID.
    expect((await pdf.extractImage(all[1].id)).width).toBe(1);

    for (const minWidth of [0, -1, 1.5, Number.NaN])
      await expect(pdf.getImages({ minWidth })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
  } finally {
    await pdf.close();
  }
});

it('IMG-06: the size filter measures images as exported, after orientation correction', async () => {
  // A 3×2 raster drawn a quarter turn rotated is exported 2 wide and 3 high.
  const pdf = await openPdf(
    pdfWithImage('q 0 60 -40 0 90 500 cm /I Do Q', 3, 2, new Uint8Array(18)),
  );
  try {
    const wide = await pdf.getImages({ minWidth: 3 });
    expect(wide).toHaveLength(0);
    expect(wide.ignoredCount).toBe(1);
    const tall = await pdf.getImages({ minHeight: 3 });
    expect(tall).toHaveLength(1);
    expect(tall.ignoredCount).toBe(0);
  } finally {
    await pdf.close();
  }
});

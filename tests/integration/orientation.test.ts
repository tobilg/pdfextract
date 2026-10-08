import { resolve } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { decode } from 'fast-png';
import { expect, it } from 'vitest';
import { openPdf } from '../../packages/core/dist/index-node.js';
import { createTesseractOcr } from '../../packages/ocr/dist/index-node.js';
import { pdfWithImage } from '../helpers/pdf.js';

const invert = ([a, b, c, d, e, f]: readonly number[]) => {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
};
const color = (index: number) => [index * 40, 255 - index * 40, (index % 2) * 255];

it('IMG-05: exports correct mirrored and quarter-turn placements as they appear on the page', async () => {
  // Every pixel of the 3×2 source has a distinct color, so any wrong mapping is visible.
  const rgb = new Uint8Array(Array.from({ length: 6 }, (_, i) => color(i)).flat());
  const tilt = (Math.PI * 10) / 180,
    cos = Math.cos(tilt),
    sin = Math.sin(tilt);
  // PDF user-space placements (y up) covering all eight mirror/quarter-turn combinations.
  const placements = [
    [60, 0, 0, 40, 50, 700],
    [-60, 0, 0, 40, 210, 700],
    [60, 0, 0, -40, 250, 740],
    [-60, 0, 0, -40, 410, 740],
    [0, 60, -40, 0, 90, 500],
    [0, -60, 40, 0, 150, 560],
    [0, 60, 40, 0, 250, 500],
    [0, -60, -40, 0, 390, 560],
    [60 * cos, 60 * sin, -40 * sin, 40 * cos, 100, 300],
    [-60 * cos, -60 * sin, -40 * sin, 40 * cos, 300, 300],
  ];
  const content = placements.map((m) => `q ${m.map((v) => v.toFixed(4)).join(' ')} cm /I Do Q`);
  const pdf = await openPdf(pdfWithImage(content.join('\n'), 3, 2, rgb));
  try {
    const [image] = await pdf.getImages();
    expect(image.width).toBe(3);
    expect(image.height).toBe(2);
    const occurrences = image.occurrences;
    expect(occurrences).toHaveLength(placements.length);
    const orientations = occurrences.map(
      (o) => `${o.originalOrientation.rotation}${o.originalOrientation.mirrored ? 'm' : ''}`,
    );
    expect(new Set(orientations.slice(0, 8)).size).toBe(8);
    expect(orientations[0]).toBe('0');
    expect(orientations[1]).toBe('0m');
    // Small tilts are not rounded to a quarter turn; mirroring is still corrected.
    expect(orientations.slice(8)).toEqual(['0', '0m']);

    for (const occurrence of occurrences.slice(0, 8)) {
      const png = await pdf.extractImage(image.id, { occurrenceId: occurrence.occurrenceId });
      const { width, height, data } = decode(png.data);
      expect([width, height]).toEqual([png.width, png.height]);
      const quarter = occurrence.originalOrientation.rotation % 180 === 90;
      expect([width, height]).toEqual(quarter ? [2, 3] : [3, 2]);
      // Oracle: each upright output pixel shows the source pixel drawn at that page position.
      const toImage = invert(occurrence.imageToPage),
        box = occurrence.bbox;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const px = box.x + ((x + 0.5) * box.width) / width,
            py = box.y + ((y + 0.5) * box.height) / height;
          const sx = Math.floor(toImage[0] * px + toImage[2] * py + toImage[4]),
            sy = Math.floor(toImage[1] * px + toImage[3] * py + toImage[5]);
          const o = (y * width + x) * 4;
          expect(
            [...data.slice(o, o + 3)],
            `${orientations[occurrences.indexOf(occurrence)]}`,
          ).toEqual(color(sy * 3 + sx));
        }
    }

    const mirrored = occurrences[1].occurrenceId,
      quarter = occurrences[4].occurrenceId;
    // The stored raster stays available unchanged.
    const original = decode(
      (await pdf.extractImage(image.id, { occurrenceId: mirrored, preserveOrientation: true }))
        .data,
    ).data;
    expect([...original.slice(0, 3)]).toEqual(color(0));
    // The default uses the first placement, which is upright here.
    expect([...decode((await pdf.extractImage(image.id)).data).data.slice(0, 3)]).toEqual(color(0));
    // Thumbnail bounds apply to the corrected (portrait) orientation.
    const thumbnail = await pdf.extractImage(image.id, {
      occurrenceId: quarter,
      maxWidth: 2,
      maxHeight: 2,
    });
    expect([thumbnail.width, thumbnail.height]).toEqual([1, 2]);
    await expect(pdf.extractImage(image.id, { occurrenceId: 'missing' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  } finally {
    await pdf.close();
  }
});

it('OCR-06: recognizes text in a stored-mirrored raster that the page displays correctly', async () => {
  const width = 480,
    height = 96,
    canvas = createCanvas(width, height),
    context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  // Store the raster mirrored; the placement below mirrors it back on the page.
  context.translate(width, 0);
  context.scale(-1, 1);
  context.fillStyle = '#000';
  context.font = 'bold 56px sans-serif';
  context.fillText('MIRROR 4821', 16, 70);
  const rgba = context.getImageData(0, 0, width, height).data,
    rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) rgb.set(rgba.subarray(i * 4, i * 4 + 3), i * 3);
  const provider = createTesseractOcr({
    languages: ['eng'],
    assets: { languageDataBaseUrl: resolve('node_modules/@tesseract.js-data/eng/4.0.0') },
  });
  const pdf = await openPdf(pdfWithImage('q -400 0 0 80 500 600 cm /I Do Q', width, height, rgb), {
    ocr: provider,
  });
  try {
    const [image] = await pdf.getImages();
    expect(image.occurrences[0].originalOrientation).toEqual({ rotation: 0, mirrored: true });
    const result = await pdf.getStructuredText({ ocr: 'auto' });
    expect(result.fullText).toContain('MIRROR');
    expect(result.fullText).toContain('4821');
    // Word boxes still map into the placement on the page: the first word is on its left.
    const words = result.pages[0].blocks.flatMap((b) => b.lines.flatMap((l) => l.spans));
    const first = words.find((w) => w.text.includes('MIRROR'));
    const box = image.occurrences[0].bbox;
    expect(first?.bbox.x).toBeGreaterThanOrEqual(box.x - 1);
    expect(first?.bbox.x).toBeLessThan(box.x + box.width / 2);
  } finally {
    await pdf.close();
    await provider.close();
  }
});

import { expect, test } from '@playwright/test';
import { decode } from 'fast-png';
import { TestPdf } from '../helpers/pdf.js';

// One page: a ruled 3×3 table; an opaque red image with a blue square drawn over it; and a
// half-transparent red image above black, with a small blue square over it.
function fixture() {
  const doc = new TestPdf();
  const opaque = doc.image(40, 20, () => [255, 0, 0]);
  const half = doc.image(
    40,
    20,
    () => [255, 0, 0],
    (x) => (x < 20 ? 0 : 255),
  );
  const cells = [
    ['Part', 'Qty', 'Price'],
    ['Bolt', '12', '0.40'],
    ['Nut', '30', '0.15'],
  ];
  doc.page(
    [
      ...[700, 680, 660, 640].map((y) => `50 ${y} m 350 ${y} l S`),
      ...[50, 150, 250, 350].map((x) => `${x} 700 m ${x} 640 l S`),
      ...cells.flatMap((row, r) =>
        row.map((cell, c) => `BT /F 10 Tf ${55 + c * 100} ${686 - r * 20} Td (${cell}) Tj ET`),
      ),
      'q 40 0 0 20 100 500 cm /A Do Q',
      '0 0 1 rg 110 505 10 10 re f',
      '0 0 0 rg 290 490 60 40 re f',
      'q 40 0 0 20 300 500 cm /B Do Q',
      '0 0 1 rg 330 505 5 5 re f',
    ].join('\n'),
    { xobjects: { A: opaque, B: half } },
  );
  return Buffer.from(doc.build());
}
type Result = {
  ok: boolean;
  dom: boolean;
  error?: string;
  tables: { detection: string; rowCount: number; columnCount: number; cells: string[] }[];
  images: { width: number; height: number; overlaid: boolean; composited: string; png: number[] }[];
};

for (const context of ['window', 'worker'] as const)
  test(`TABLE-01 COMP-01: tables and composite images in a ${context}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('./worker.html');
    await page.locator('#context').selectOption(context);
    await page.locator('#tables').check();
    await page.locator('#composite').check();
    await page.locator('#pdf').setInputFiles({
      name: 'features.pdf',
      mimeType: 'application/pdf',
      buffer: fixture(),
    });
    await expect(page.locator('#status')).toContainText(
      `Done in ${context} (DOM: ${context === 'window'})`,
      { timeout: 60000 },
    );
    const result = (await page.evaluate(() => {
      const data = window.pdfextractResult;
      if (!data?.ok) return data;
      // PNG bytes as plain arrays for the Node side.
      return {
        ...data,
        images: data.images.map((image) => ({ ...image, png: Array.from(image.png ?? []) })),
      };
    })) as Result;
    expect(result.ok, result.error).toBe(true);

    expect(result.tables).toEqual([
      {
        detection: 'ruled',
        rowCount: 3,
        columnCount: 3,
        cells: ['Part', 'Qty', 'Price', 'Bolt', '12', '0.40', 'Nut', '30', '0.15'],
      },
    ]);
    expect(result.dom).toBe(context === 'window');

    const [opaque, half] = result.images;
    const pixel = (image: Result['images'][number], x: number, y: number) => {
      const png = decode(Uint8Array.from(image.png));
      expect([png.width, png.height]).toEqual([40, 20]);
      const o = (y * png.width + x) * 4;
      return Array.from(png.data.subarray(o, o + 4));
    };
    const near = (actual: number[], expected: number[]) =>
      expect(
        actual.every((v, i) => Math.abs(v - expected[i]) <= 3),
        `${actual}`,
      ).toBe(true);
    for (const image of [opaque, half])
      expect([image.overlaid, image.composited]).toEqual([true, 'above']);
    // The blue square is composited over the opaque image.
    near(pixel(opaque, 15, 10), [0, 0, 255, 255]);
    near(pixel(opaque, 2, 2), [255, 0, 0, 255]);
    // The black area drawn below stays out of the transparent half.
    expect(pixel(half, 5, 10)[3]).toBe(0);
    near(pixel(half, 25, 10), [255, 0, 0, 255]);
    near(pixel(half, 32, 12), [0, 0, 255, 255]);
    expect(errors).toEqual([]);
  });

// One page: an image inside a full-page Form XObject (not clipped), a plain image, and an image
// with Type3 text (1/100 em glyph units) drawn over it.
function placementsFixture() {
  const doc = new TestPdf();
  const formed = doc.image(16, 8, (x, y) => [x * 16, y * 32, 90]);
  const plain = doc.image(12, 12, (x, y) => [200, x * 20, y * 20]);
  const covered = doc.image(40, 20, () => [0, 160, 0]);
  const form = doc.add(
    `<< /Type /XObject /Subtype /Form /BBox [0 0 600 800] /Resources << /XObject << /I ${formed} 0 R >> >> >>`,
    Buffer.from('q 80 0 0 40 50 700 cm /I Do Q'),
  );
  const glyph = doc.add('<< >>', Buffer.from('100 0 0 0 100 100 d1 0 0 100 100 re f'));
  const type3 = doc.add(
    `<< /Type /Font /Subtype /Type3 /FontBBox [0 0 100 100] /FontMatrix [0.01 0 0 0.01 0 0] /CharProcs << /A ${glyph} 0 R >> /Encoding << /Type /Encoding /Differences [65 /A] >> /FirstChar 65 /LastChar 65 /Widths [100] /Resources << >> >>`,
  );
  doc.page(
    [
      '/Fm Do',
      'q 60 0 0 60 250 650 cm /P Do Q',
      'q 40 0 0 20 400 600 cm /C Do Q',
      // Five 10 pt glyphs from x 360 span 50 pt, reaching the image at x 400.
      'BT /T 10 Tf 360 605 Td (AAAAA) Tj ET',
    ].join('\n'),
    { xobjects: { Fm: form, P: plain, C: covered }, fonts: { T: type3 } },
  );
  return Buffer.from(doc.build());
}

for (const context of ['window', 'worker'] as const)
  test(`CLIP-01 TEXT-01 CACHE-01: placements, text extents and repeated exports in a ${context}`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('./worker.html');
    await page.locator('#context').selectOption(context);
    await page.locator('#composite').check();
    await page.locator('#repeat').check();
    await page.locator('#pdf').setInputFiles({
      name: 'placements.pdf',
      mimeType: 'application/pdf',
      buffer: placementsFixture(),
    });
    await expect(page.locator('#status')).toContainText(`Done in ${context}`, { timeout: 60000 });
    const result = (await page.evaluate(() => {
      const data = window.pdfextractResult;
      if (!data?.ok) return data;
      return {
        ok: true,
        repeatable: data.repeatable,
        images: data.images.map(({ width, height, overlaid, clipped, composited }) => ({
          width,
          height,
          overlaid,
          clipped,
          composited,
        })),
      };
    })) as {
      ok: boolean;
      error?: string;
      repeatable?: boolean;
      images: {
        width: number;
        height: number;
        overlaid: boolean;
        clipped: boolean;
        composited: string;
      }[];
    };
    expect(result.ok, result.error).toBe(true);
    expect(result.images).toEqual([
      // Inside a full-page form: not clipped, so the exact pixels are exported.
      { width: 16, height: 8, overlaid: false, clipped: false, composited: 'none' },
      { width: 12, height: 12, overlaid: false, clipped: false, composited: 'none' },
      // Type3 text reaches it, so it is rendered with the text on top.
      { width: 40, height: 20, overlaid: true, clipped: false, composited: 'above' },
    ]);
    // Both exact exports of the page came out byte-identical the second time.
    expect(result.repeatable).toBe(true);
    expect(errors).toEqual([]);
  });

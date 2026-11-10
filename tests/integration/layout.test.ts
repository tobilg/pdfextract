import type { OcrProvider, OcrRaster, OcrResult } from '@pdfextract/core';
import { expect, it } from 'vitest';
import { openPdf } from '../../packages/core/dist/index-node.js';
import { pdfWithImage, pdfWithRuns } from '../helpers/pdf.js';

const textOf = async (bytes: Uint8Array, provider?: OcrProvider) => {
  const pdf = await openPdf(bytes, provider ? { ocr: provider } : {});
  try {
    return await pdf.getStructuredText();
  } finally {
    await pdf.close();
  }
};

it('CORE-02: a full-width heading and footer do not merge narrow-gutter prose columns', async () => {
  const left = [
      'Shipments from the northern hub grew',
      'steadily during the third quarter and',
      'handling times fell to three hours.',
    ],
    right = [
      'Complaints about late deliveries fell',
      'by a third, mostly in rural areas',
      'where carrier coverage is thin.',
    ];
  const text = await textOf(
    pdfWithRuns([
      { x: 72, y: 720, size: 16, text: 'Quarterly Operations Review for the Northern Region' },
      // Rows are aligned across a 19pt gutter, which the heading and the footer both cross.
      ...left.map((text, i) => ({ x: 72, y: 680 - i * 13, size: 10, text })),
      ...right.map((text, i) => ({ x: 262, y: 680 - i * 13, size: 10, text })),
      { x: 230, y: 40, size: 10, text: 'Page 1 of 1' },
    ]),
  );
  const lines = text.pages[0].blocks.flatMap((b) => b.lines);
  const gutter =
    Math.min(...lines.filter((l) => right.includes(l.text)).map((l) => l.bbox.x)) -
    Math.max(...lines.filter((l) => left.includes(l.text)).map((l) => l.bbox.x + l.bbox.width));
  expect(gutter).toBeGreaterThan(10);
  expect(gutter).toBeLessThan(30);
  expect(text.pages[0].fullText).toBe(
    [
      'Quarterly Operations Review for the Northern Region',
      left.join('\n'),
      right.join('\n'),
      'Page 1 of 1',
    ].join('\n\n'),
  );
});

it('CORE-02: table cells with modest spacing are a table read row by row', async () => {
  const rows = [
    ['Item', 'Qty', 'Price'],
    ['Widget', '2', '9.99'],
    ['Gadget', '10', '4.50'],
    ['Bolt', '100', '0.10'],
  ];
  const text = await textOf(
    pdfWithRuns(
      rows.flatMap((row, r) =>
        // Column gutters of 10–13pt; every gap between neighbouring cells is under 30pt.
        row.map((cell, c) => ({ x: [72, 115, 145][c], y: 700 - r * 14, size: 10, text: cell })),
      ),
    ),
  );
  expect(text.pages[0].tables[0]?.detection).toBe('aligned');
  expect(text.pages[0].fullText).toBe(rows.map((row) => row.join('\t')).join('\n'));
});

it('CORE-02: right-aligned page numbers stay with their table-of-contents entries', async () => {
  const entries = [
    ['Introduction', '7'],
    ['1. Changing Practices, Shifting Sites', '7'],
    ['2. Core and Periphery of Play', '12'],
    ['Part I: New Children, Different Toys', '21'],
    ['3. The Child as Consumer', '26'],
  ];
  // Page numbers end at x = 380 (Helvetica digits are 5.56pt wide), well over 30pt from the text.
  const text = await textOf(
    pdfWithRuns(
      entries.flatMap(([entry, page], i) => [
        { x: 72, y: 700 - i * 14, size: 10, text: entry },
        { x: 380 - page.length * 5.56, y: 700 - i * 14, size: 10, text: page },
      ]),
    ),
  );
  // Two columns are not a table; each entry and its distant page number share a line.
  expect(text.pages[0].tables).toEqual([]);
  expect(text.pages[0].fullText).toBe(entries.map((row) => row.join('\t')).join('\n'));
});

/** Answers every raster with fixed lines, given in units of the raster's own width. */
function fixedProvider(lines: { words: [string, number, number, number, number][] }[]) {
  const rasters: OcrRaster[] = [];
  const provider: OcrProvider = {
    async recognize(raster): Promise<OcrResult> {
      rasters.push(raster);
      const u = raster.width / 1000;
      const box = (x: number, y: number, w: number, h: number) => ({
        x: x * u,
        y: y * u,
        width: w * u,
        height: h * u,
      });
      return {
        text: '',
        warnings: [],
        lines: lines.map(({ words }) => ({
          text: words.map((w) => w[0]).join(' '),
          bbox: box(0, 0, 1, 1),
          words: words.map(([text, x, y, w, h]) => ({ text, bbox: box(x, y, w, h) })),
        })),
      };
    },
    async close() {},
  };
  return { provider, rasters };
}

it('OCR-09: a scan under a clean text layer is not recognized; a poor layer gives way to recognition', async () => {
  // A full-page scan with an invisible text layer (render mode 3) of 24 lines down the page.
  const layer = (lines: string[]) =>
    [
      'q 600 0 0 800 0 0 cm /I Do Q',
      'BT /F 10 Tf 3 Tr',
      ...lines.map(
        (line, i) => `1 0 0 1 72 ${740 - i * 26} Tm (${line.replace(/[()\\]/g, '\\$&')}) Tj`,
      ),
      'ET',
    ].join('\n');
  const clean = Array.from({ length: 24 }, (_, i) => `Minutes of meeting number ${i + 1} held`);
  const words = (y: number, list: string[]) => ({
    words: list.map((w, i): [string, number, number, number, number] => [
      w,
      60 + i * 150,
      y,
      130,
      20,
    ]),
  });
  const recognized = fixedProvider([
    words(80, ['Clean', 'recognized', 'words', 'of', 'the', 'scan']),
    words(120, ['Second', 'line', 'read', 'here', 'as', 'well']),
  ]);
  const page = (lines: string[]) =>
    pdfWithImage(layer(lines), 1000, 1333, new Uint8Array(1000 * 1333 * 3).fill(255));
  const good = await textOf(page(clean), recognized.provider);
  expect(recognized.rasters).toHaveLength(0);
  expect(good.pages[0].fullText).toContain('Minutes of meeting number 1 held');
  // Debris from an earlier, poor recognition: the new words replace the layer.
  const debris = Array.from({ length: 20 }, (_, i) => `0Ql.5)')8${i}`);
  const poor = await textOf(page(debris), recognized.provider);
  expect(recognized.rasters).toHaveLength(1);
  expect(poor.pages[0].fullText).toBe(
    'Clean recognized words of the scan\n\nSecond line read here as well',
  );
});

it('OCR-10: images too small to hold a letter are not recognized', async () => {
  // A 1×1 mask stretched into a rule, as TeX drivers draw fraction bars, and a 2 pt dot.
  const { provider, rasters } = fixedProvider([{ words: [['bar', 0, 0, 10, 10]] }]);
  const rule = pdfWithImage('q 200 0 0 0.4 100 400 cm /I Do Q', 1, 1, new Uint8Array(3));
  expect((await textOf(rule, provider)).pages[0].fullText).toBe('');
  const dot = pdfWithImage('q 2 0 0 2 100 400 cm /I Do Q', 40, 40, new Uint8Array(4800));
  await textOf(dot, provider);
  expect(rasters).toHaveLength(0);
});

it('OCR-03: provider lines stay intact despite glyph-tight word boxes, and columns stay apart', async () => {
  // Words without ascenders ("an", "a", "on") have lower, shorter boxes than their neighbours.
  const line = (y: number, x: number, words: string[]) => {
    let left = x;
    return {
      words: words.map((word) => {
        const short = !/[A-Zbdfhklt]/.test(word),
          w = word.length * 14;
        const entry: [string, number, number, number, number] = [
          word,
          left,
          short ? y + 10 : y,
          w,
          short ? 22 : 32,
        ];
        left += w + 12;
        return entry;
      }),
    };
  };
  const { provider } = fixedProvider([
    line(100, 20, ['There', 'was', 'an', 'issue', 'on', 'a', 'route']),
    line(150, 20, ['Several', 'vans', 'ran', 'late', 'again']),
    line(100, 560, ['Costs', 'rose', 'as', 'fuel', 'prices', 'grew']),
    line(150, 560, ['Savings', 'came', 'from', 'new', 'routes']),
  ]);
  // 1000×500 px drawn at 240×120 pt: 300 DPI, so the raster is not enlarged.
  const pdf = pdfWithImage('q 240 0 0 120 30 600 cm /I Do Q', 1000, 500, new Uint8Array(1.5e6));
  const text = await textOf(pdf, provider);
  expect(text.pages[0].fullText).toBe(
    [
      'There was an issue on a route\nSeveral vans ran late again',
      'Costs rose as fuel prices grew\nSavings came from new routes',
    ].join('\n\n'),
  );
});

it('OCR-05: low-resolution image regions are enlarged, report their DPI and map back to the page', async () => {
  const { provider, rasters } = fixedProvider([{ words: [['WORD', 300, 100, 400, 200]] }]);
  // 300×100 px drawn at 300×100 pt is 72 DPI: enlarged 4× (the cap) to 1200×400 at 288 DPI.
  const pdf = pdfWithImage('q 300 0 0 100 100 600 cm /I Do Q', 300, 100, new Uint8Array(9e4));
  const text = await textOf(pdf, provider);
  expect([rasters[0].width, rasters[0].height]).toEqual([1200, 400]);
  expect(rasters[0].dpi).toBeCloseTo(288);
  // Provider box (360, 120, 480, 240) px is (90, 30, 120, 60) pt inside the placement at (100, 100).
  const [span] = text.pages[0].blocks[0].lines[0].spans;
  expect(span.bbox.x).toBeCloseTo(190);
  expect(span.bbox.y).toBeCloseTo(130);
  expect(span.bbox.width).toBeCloseTo(120);
  expect(span.bbox.height).toBeCloseTo(60);
});

it('OCR-05: an image over the OCR pixel budget is reduced by area average to fit it', async () => {
  const { provider, rasters } = fixedProvider([{ words: [['WORD', 300, 100, 400, 200]] }]);
  // 2000×1000 px of alternating black and white columns, drawn at 480×240 pt (300 DPI). A
  // 500,000-pixel budget halves it to 1000×500 at 150 DPI; each output pixel averages a black
  // and a white column, where sampling would keep one or the other.
  const rgb = new Uint8Array(2000 * 1000 * 3);
  for (let i = 0; i < rgb.length; i += 3) rgb.fill((i / 3) % 2 ? 255 : 0, i, i + 3);
  const pdf = await openPdf(pdfWithImage('q 480 0 0 240 30 500 cm /I Do Q', 2000, 1000, rgb), {
    ocr: provider,
    limits: { maxOcrPixels: 500_000 },
  });
  try {
    const text = await pdf.getStructuredText({ ocr: 'auto' });
    const [raster] = rasters;
    expect([raster.width, raster.height]).toEqual([1000, 500]);
    expect(raster.dpi).toBeCloseTo(150);
    const reds = new Set<number>();
    for (let p = 0; p < raster.data.length; p += 4) reds.add(raster.data[p]);
    expect([...reds].every((r) => r >= 127 && r <= 128)).toBe(true);
    // Provider box (300, 100, 400, 200) px at 0.48 pt/px inside the placement at (30, 60).
    const [span] = text.pages[0].blocks[0].lines[0].spans;
    expect(span.bbox.x).toBeCloseTo(174);
    expect(span.bbox.y).toBeCloseTo(108);
    expect(span.bbox.width).toBeCloseTo(192);
    expect(span.bbox.height).toBeCloseTo(96);
  } finally {
    await pdf.close();
  }
});

it('OCR-05: full-page OCR renders at 300 DPI within the OCR pixel budget', async () => {
  const { provider, rasters } = fixedProvider([]);
  const bytes = pdfWithRuns([{ x: 72, y: 700, size: 10, text: 'Native text' }]);
  for (const [maxOcrPixels, dpi] of [
    [16_000_000, 300],
    [4_000_000, 72 * Math.sqrt(4_000_000 / (612 * 792))],
  ]) {
    const pdf = await openPdf(bytes, { ocr: provider, limits: { maxOcrPixels } });
    try {
      await pdf.getStructuredText({ ocr: 'always' });
    } finally {
      await pdf.close();
    }
    expect(rasters.at(-1)?.dpi).toBeCloseTo(dpi);
    expect((rasters.at(-1)?.width ?? 0) * (rasters.at(-1)?.height ?? 0)).toBeLessThanOrEqual(
      maxOcrPixels + 612 * 5 + 792 * 5,
    );
  }
});

it('CORE-02: a column that starts higher than its neighbour is read in its column', async () => {
  const left = [
      'Participants in a conversation coordinate',
      'with one another on producing their turns,',
      'and they do so continuously and quickly.',
    ],
    right = [
      'the gaze of the speaker and when mutual',
      'gaze is maintained, as marked in the',
      'example shown in the figure below here.',
    ];
  const text = await textOf(
    pdfWithRuns([
      { x: 72, y: 740, size: 16, text: 'Incremental Coordination in Dialogue' },
      // The right column starts a line higher: its first line is a strip of its own.
      ...right.map((t, i) => ({ x: 320, y: 693 - i * 13, size: 10, text: t })),
      ...left.map((t, i) => ({ x: 72, y: 680 - i * 13, size: 10, text: t })),
    ]),
  );
  expect(text.pages[0].fullText).toBe(
    ['Incremental Coordination in Dialogue', left.join('\n'), right.join('\n')].join('\n\n'),
  );
});

it('OCR-05: a scan on a page larger than any paper is read again without the geometry DPI when it yields nothing', async () => {
  // 400×300 px placed over a 1600×1200 pt page (an image-to-PDF tool's 18 DPI). The first read
  // (enlarged, with that DPI) finds nothing; the second, at the image's own size without a DPI,
  // finds the word.
  const rasters: OcrRaster[] = [];
  const provider: OcrProvider = {
    async recognize(raster) {
      rasters.push(raster);
      const found = raster.dpi === undefined;
      const u = raster.width / 400;
      return {
        text: found ? 'Archive' : '',
        warnings: [],
        lines: found
          ? [
              {
                text: 'Archive',
                bbox: { x: 40 * u, y: 40 * u, width: 120 * u, height: 30 * u },
                words: [
                  {
                    text: 'Archive',
                    bbox: { x: 40 * u, y: 40 * u, width: 120 * u, height: 30 * u },
                  },
                ],
              },
            ]
          : [],
      };
    },
    async close() {},
  };
  const pdf = await openPdf(
    pdfWithImage(
      'q 1600 0 0 1200 0 0 cm /I Do Q',
      400,
      300,
      new Uint8Array(400 * 300 * 3),
      [1600, 1200],
    ),
    { ocr: provider },
  );
  try {
    const text = await pdf.getStructuredText({ ocr: 'auto' });
    expect(rasters.map((r) => [r.width, r.dpi === undefined])).toEqual([
      [1600, false],
      [400, true],
    ]);
    expect(text.pages[0].fullText).toBe('Archive');
    // Mapped back through the 4 pt-per-pixel placement: (40, 40) px is (160, 160) pt.
    const [span] = text.pages[0].blocks[0].lines[0].spans;
    expect(span.bbox.x).toBeCloseTo(160);
  } finally {
    await pdf.close();
  }
});

import type { OcrProvider, OcrRaster, StructuredText } from '@pdfextract/core';
import { expect, it } from 'vitest';
import { openPdf, toMarkdown } from '../../packages/core/dist/index-node.js';
import { pdfWithRuns } from '../helpers/pdf.js';

const structure = async (bytes: Uint8Array, ocr?: OcrProvider, options = {}) => {
  const pdf = await openPdf(bytes, ocr ? { ocr } : {});
  try {
    return await pdf.getStructuredText(options);
  } finally {
    await pdf.close();
  }
};
const body = [
  'Samples were collected from every district reservoir during the',
  'spring and autumn campaigns and analysed by an accredited lab.',
  'All results are reported as annual averages per sampling site.',
];

it('CORE-05: headings by size and weight; footers, leaders and captions are not headings', async () => {
  const text = await structure(
    pdfWithRuns([
      { x: 72, y: 720, size: 20, text: 'Annual Water Quality Report' },
      ...body.map((line, i) => ({ x: 72, y: 690 - i * 13, size: 10, text: line })),
      { x: 72, y: 630, size: 10, text: 'Methods and Sampling', bold: true },
      ...body.map((line, i) => ({ x: 72, y: 612 - i * 13, size: 10, text: line })),
      { x: 72, y: 560, size: 10, text: 'Results ........................ 12', bold: true },
      { x: 72, y: 530, size: 10, text: 'Figure 2: Sampling sites', bold: true },
      { x: 290, y: 30, size: 10, text: 'Page 3', bold: true },
    ]),
  );
  const blocks = text.pages[0].blocks;
  const headings = blocks.filter((b) => b.headingLevel);
  expect(headings.map((b) => [b.text, b.headingLevel])).toEqual([
    ['Annual Water Quality Report', 1],
    ['Methods and Sampling', 2],
  ]);
  // The bold heading line is split out of the paragraph it was set tight against.
  expect(
    blocks.find((b) => b.text.startsWith('Samples') && b.text.includes('Methods')),
  ).toBeFalsy();
  const spans = blocks.flatMap((b) => b.lines.flatMap((l) => l.spans));
  expect(spans.find((s) => s.text === 'Methods and Sampling')?.fontName).toBe('Helvetica-Bold');
  expect(spans.find((s) => s.text === body[0])?.fontName).toBe('Helvetica');
});

it('CORE-05: Markdown renders a detected ruled table as a pipe table in reading order', async () => {
  // Rules: verticals stroked, horizontals as thin filled rectangles (both are common).
  const xs = [72, 180, 300],
    ys = [700, 680, 660, 640];
  const graphics = [
    '0.5 w',
    ...xs.map((x) => `${x} 640 m ${x} 700 l S`),
    ...ys.map((y) => `72 ${y - 0.25} 228 0.5 re f`),
  ].join('\n');
  const cells = [
    ['Parameter', 'Limit'],
    ['Lead', '15 ppb'],
    ['Copper', '1.3 ppm'],
  ];
  const text = await structure(
    pdfWithRuns(
      [
        { x: 72, y: 730, size: 10, text: 'Contaminant limits are listed below.' },
        ...cells.flatMap((row, r) =>
          row.map((cell, c) => ({ x: xs[c] + 6, y: ys[r] - 14, size: 10, text: cell })),
        ),
        { x: 72, y: 610, size: 10, text: 'Both metals stayed below their limits.' },
      ],
      graphics,
    ),
  );
  expect(text.pages[0].tables).toHaveLength(1);
  expect(toMarkdown(text)).toBe(
    [
      'Contaminant limits are listed below.',
      '| Parameter | Limit |\n| --- | --- |\n| Lead | 15 ppb |\n| Copper | 1.3 ppm |',
      'Both metals stayed below their limits.',
    ].join('\n\n'),
  );
});

it('CORE-05: Markdown renders headings, tables with merged cells and literal paragraph lines', () => {
  const box = { x: 0, y: 0, width: 1, height: 1 };
  const line = (text: string) => ({ text, bbox: box, spans: [] });
  const cell = (row: number, column: number, text: string, columnSpan = 1) => ({
    row,
    column,
    rowSpan: 1,
    columnSpan,
    text,
    bbox: box,
  });
  const page = (
    blocks: StructuredText['pages'][number]['blocks'],
    tables: StructuredText['pages'][number]['tables'] = [],
  ) => ({
    pageNumber: 1,
    width: 1,
    height: 1,
    rotation: 0 as const,
    fullText: '',
    blocks,
    tables,
    ocrStatus: 'disabled' as const,
    warnings: [],
  });
  const result: StructuredText = {
    schemaVersion: 1,
    status: 'complete',
    pageCount: 2,
    fullText: '',
    warnings: [],
    pages: [
      page(
        [
          { text: 'Overview', bbox: box, lines: [line('Overview')], headingLevel: 2 },
          { text: '', bbox: box, lines: [line('# not a heading'), line('---'), line('plain')] },
          { text: '', bbox: box, lines: [], tableIndex: 0 },
        ],
        [
          {
            bbox: box,
            rowCount: 2,
            columnCount: 2,
            detection: 'ruled',
            // The header cell spans both columns: an HTML table, or a pipe table with its text
            // in the first column.
            cells: [cell(0, 0, 'Name and note', 2), cell(1, 0, 'A|B'), cell(1, 1, 'two\nlines')],
          },
        ],
      ),
      page([{ text: 'Second', bbox: box, lines: [line('Second page')] }]),
    ],
  };
  // Lines as laid out: each one is kept from reading as a heading or a setext underline.
  expect(toMarkdown(result, { lines: 'preserve' })).toBe(
    [
      '## Overview',
      '',
      '\\# not a heading\n\\---\nplain',
      '',
      '<table>\n<tr><th colspan="2">Name and note</th></tr>\n<tr><th>A|B</th><td>two lines</td></tr>\n</table>',
      '',
      '---',
      '',
      'Second page',
    ].join('\n'),
  );
  expect(toMarkdown(result, { tables: 'pipe' })).toContain(
    '| Name and note |  |\n| --- | --- |\n| A\\|B | two lines |',
  );
  expect(toMarkdown(result, { pageSeparator: '\n\n' })).toMatch(/<\/table>\n\nSecond page$/);
  // By default a paragraph is one line, escaped at its start.
  expect(toMarkdown(result)).toContain('\n\n\\# not a heading --- plain\n\n');
});

it('CORE-05: Markdown paragraphs rejoin words hyphenated at line ends', () => {
  const box = { x: 0, y: 0, width: 1, height: 1 };
  const line = (text: string) => ({ text, bbox: box, spans: [] });
  const lines = [
    'The guide-',
    'lines name a well-',
    'known method for TGF-',
    'beta, the self-',
    'test and the co\u00ad',
    'operation of 12 labs:',
    '• one',
    '• two',
  ];
  const text = 'The self-test is a well-known method.';
  const result: StructuredText = {
    schemaVersion: 1,
    status: 'complete',
    pageCount: 1,
    fullText: text,
    warnings: [],
    pages: [
      {
        pageNumber: 1,
        width: 1,
        height: 1,
        rotation: 0,
        fullText: text,
        blocks: [{ text: lines.join('\n'), bbox: box, lines: lines.map(line) }],
        tables: [],
        ocrStatus: 'disabled',
        warnings: [],
      },
    ],
  };
  // Hyphens after a capital or in words written with one elsewhere stay; list items keep
  // their lines.
  expect(toMarkdown(result)).toBe(
    'The guidelines name a well-known method for TGF-beta, the self-test and the cooperation of 12 labs:\n• one\n• two',
  );
});

/** Records rasters; answers with words placed in page points via the raster's DPI. */
function recorder(words: { text: string; x: number; y: number; w: number; confidence?: number }[]) {
  const rasters: OcrRaster[] = [];
  const provider: OcrProvider = {
    async recognize(raster) {
      rasters.push(raster);
      const k = (raster.dpi ?? 72) / 72;
      const box = (x: number, y: number, w: number) => ({
        x: x * k,
        y: y * k,
        width: w * k,
        height: 10 * k,
      });
      return {
        text: '',
        warnings: [],
        lines: words.map((word) => ({
          text: word.text,
          bbox: box(word.x, word.y, word.w),
          words: [
            { text: word.text, bbox: box(word.x, word.y, word.w), confidence: word.confidence },
          ],
        })),
      };
    },
    async close() {},
  };
  return { provider, rasters };
}

it('OCR-09: auto OCR renders a page whose lettering is drawn as vector shapes', async () => {
  // 60 filled glyph-like shapes and no text: outlined lettering, invisible to image OCR.
  const shapes = Array.from(
    { length: 60 },
    (_, i) => `${72 + (i % 20) * 12} ${700 - Math.floor(i / 20) * 20} 8 12 re f`,
  ).join('\n');
  const outlined = recorder([{ text: 'Outlined', x: 72, y: 80, w: 60, confidence: 0.9 }]);
  const text = await structure(pdfWithRuns([], shapes), outlined.provider, { ocr: 'auto' });
  expect(outlined.rasters).toHaveLength(1);
  expect(outlined.rasters[0].dpi).toBeCloseTo(300);
  expect(text.fullText).toBe('Outlined');
  // A few shapes, or native text beside shapes (a chart), are not outlined lettering.
  const few = recorder([]);
  await structure(pdfWithRuns([], shapes.split('\n').slice(0, 10).join('\n')), few.provider, {
    ocr: 'auto',
  });
  const chart = recorder([]);
  await structure(
    pdfWithRuns([{ x: 72, y: 600, size: 10, text: body[0] }], shapes),
    chart.provider,
    { ocr: 'auto' },
  );
  expect([few.rasters.length, chart.rasters.length]).toEqual([0, 0]);
});

it('OCR-10: low-confidence words are dropped unless minOcrConfidence is lowered', async () => {
  const { provider } = recorder([
    { text: 'noise', x: 72, y: 100, w: 30, confidence: 0.1 },
    { text: 'Signal', x: 72, y: 200, w: 40, confidence: 0.9 },
  ]);
  const bytes = pdfWithRuns([]);
  const kept = await structure(bytes, provider, { ocr: 'always' });
  expect(kept.fullText).toBe('Signal');
  const all = await structure(bytes, provider, { ocr: 'always', minOcrConfidence: 0 });
  expect(all.fullText).toBe('noise\n\nSignal');
  await expect(
    structure(bytes, provider, { ocr: 'always', minOcrConfidence: 2 }),
  ).rejects.toMatchObject({
    code: 'INVALID_ARGUMENT',
  });
});

it('OCR-11: OCR misreadings of overlapping native text are not repeated', async () => {
  const bytes = pdfWithRuns([{ x: 72, y: 700, size: 12, text: 'Quarterly results improved' }]);
  const native = (await structure(bytes)).pages[0].blocks[0].lines[0].bbox;
  // "resuIts" over the native line is a misreading of "results"; "Bonus" lies elsewhere.
  const { provider } = recorder([
    { text: 'resuIts', x: native.x + 60, y: native.y, w: 40, confidence: 0.9 },
    { text: 'Bonus', x: 72, y: 300, w: 40, confidence: 0.9 },
  ]);
  const text = await structure(bytes, provider, { ocr: 'always' });
  const ocr = text.pages[0].blocks
    .flatMap((b) => b.lines.flatMap((l) => l.spans))
    .filter((s) => s.source === 'ocr');
  expect(ocr.map((s) => s.text)).toEqual(['Bonus']);
});

it('TABLE-10: mitred border bars, a frame drawn as one ring, shaded cells and boxed lists', async () => {
  const xs = [72, 192, 312, 432],
    ys = [700, 680, 660, 640];
  const rows = [
    ['Name', 'Qty', 'Price'],
    ['Bolts', '12', '0.10'],
    ['Nuts', '30', '0.05'],
  ];
  const text = (grid: string[][], x: number[], y: number[]) =>
    grid.flatMap((row, r) =>
      row.map((cell, c) => ({ x: x[c] + 6, y: y[r] - 14, size: 10, text: cell })),
    );
  // Inner lines as filled bars with mitred ends (corners inset by the line width), the outer
  // border as a single filled ring, as some word processors export borders.
  const bar = (x0: number, y0: number, x1: number, y1: number) =>
    y0 === y1
      ? `${x0} ${y0} m ${x1} ${y0} l ${x1 - 0.75} ${y0 - 0.75} l ${x0 + 0.75} ${y0 - 0.75} l h f`
      : `${x0} ${y0} m ${x0} ${y1} l ${x0 + 0.75} ${y1 - 0.75} l ${x0 + 0.75} ${y0 + 0.75} l h f`;
  const ring =
    '72 640 m 432 640 l 432 700 l 72 700 l 72 640 l 72.75 640.75 l 72.75 699.25 l 431.25 699.25 l 431.25 640.75 l 72.75 640.75 l h f';
  const mitred = await structure(
    pdfWithRuns(
      text(rows, xs, ys),
      [
        ring,
        ...[680, 660].map((y) => bar(72, y, 432, y)),
        ...[192, 312].map((x) => bar(x, 640, x, 700)),
      ].join('\n'),
    ),
  );
  expect(mitred.pages[0].tables[0]?.detection).toBe('ruled');
  expect(toMarkdown(mitred)).toContain('| Bolts | 12 | 0.10 |');

  // Two columns of shaded cells with white gaps and no drawn line.
  const shaded = [
    ['Region', 'Share'],
    ['North', '41%'],
    ['South', '59%'],
  ];
  const fills = shaded.flatMap((row, r) =>
    row.map(
      (_, c) => `${r ? '1 0.9 0.9' : '0.8 0.2 0.2'} rg ${xs[c] + 1} ${ys[r + 1] + 1} 118 18 re f`,
    ),
  );
  const zebra = await structure(pdfWithRuns(text(shaded, xs, ys), fills.join('\n')));
  expect(zebra.pages[0].tables.map((t) => [t.detection, t.rowCount, t.columnCount])).toEqual([
    ['ruled', 3, 2],
  ]);

  // Boxed short entries in one column; the text alone suggests no table.
  const boxes = [700, 680, 660, 640, 620].map((y) => `0.5 w 72 ${y - 20} 300 20 re S`).join('\n');
  const entries = [700, 680, 660, 640, 620].map((y, i) => ({
    x: 78,
    y: y - 14,
    size: 10,
    text: `#${i + 1}: Competence area ${i + 1}`,
  }));
  const list = await structure(pdfWithRuns(entries, boxes));
  expect(list.pages[0].tables.map((t) => [t.rowCount, t.columnCount])).toEqual([[5, 1]]);
});

it('CORE-05: body type is measured with tables; captions, dates, links and entries are not headings', async () => {
  // A contents page: the entries (with page numbers) are most of the text.
  const contents = await structure(
    pdfWithRuns([
      { x: 72, y: 720, size: 24, text: 'Contents' },
      ...['Front Matter', 'Introduction', 'Our Mental Shortcuts', 'Identifying a Topic'].flatMap(
        (entry, i) => [
          { x: 72, y: 680 - i * 16, size: 9, text: `${i + 1}.` },
          { x: 100, y: 680 - i * 16, size: 9, text: entry },
          { x: 400, y: 680 - i * 16, size: 9, text: String(1 + i * 9) },
        ],
      ),
    ]),
  );
  expect(contents.pages[0].tables).toEqual([]);
  expect(contents.pages[0].blocks.filter((b) => b.headingLevel).map((b) => b.text)).toEqual([
    'Contents',
  ]);
  const page = await structure(
    pdfWithRuns([
      { x: 72, y: 740, size: 14, text: 'June 2023', bold: true },
      ...body.map((line, i) => ({ x: 72, y: 700 - i * 13, size: 10, text: line })),
      { x: 72, y: 640, size: 10, text: 'Table 2: Results by region', bold: true },
      { x: 72, y: 610, size: 10, text: 'See https://example.org/report', bold: true },
      ...body.map((line, i) => ({ x: 72, y: 580 - i * 13, size: 10, text: line })),
      { x: 72, y: 520, size: 10, text: 'References' },
      ...body.map((line, i) => ({ x: 72, y: 500 - i * 13, size: 10, text: line })),
    ]),
  );
  expect(page.pages[0].blocks.filter((b) => b.headingLevel).map((b) => b.text)).toEqual([
    'References',
  ]);
});

import { openPdf } from '@pdfextract/core';
import { describe, expect, it } from 'vitest';
import { pdfWithText, text } from '../helpers/pdf.js';

async function extract(pages: string[], options = {}, pageAttributes = '') {
  const pdf = await openPdf(pdfWithText(pages, pageAttributes));
  try {
    return await pdf.getStructuredText(options);
  } finally {
    await pdf.close();
  }
}
const line = (x1: number, y1: number, x2: number, y2: number) => `${x1} ${y1} m ${x2} ${y2} l S`;
// Fruit | Stock (merged over two columns); a two-line cell in the last row.
const ruled = [
  text(50, 740, 'Inventory'),
  '0.5 w',
  ...[700, 680, 660, 640, 600].map((y) => line(50, y, 400, y)),
  line(50, 700, 50, 600),
  line(200, 700, 200, 600),
  line(300, 680, 300, 600),
  line(400, 700, 400, 600),
  text(55, 686, 'Fruit'),
  text(205, 686, 'Stock'),
  ...[
    [666, 'Name', 'Qty', 'Price'],
    [646, 'Apple', '3', '1.20'],
  ].map(([y, ...cells]) =>
    cells.map((c, i) => text([55, 205, 305][i], y as number, c as string)).join(' '),
  ),
  text(55, 627, 'Banana'),
  text(55, 615, 'bread'),
  text(205, 627, '12'),
  text(305, 627, '4.50'),
  text(50, 570, 'Total: 3 items'),
].join('\n');
const tight = [
  ['Name', 'Qty', 'Price'],
  ['Apple', '3', '1.20'],
  ['Banana bread', '12', '4.50'],
  ['Kiwi', '', '0.80'],
]
  .flatMap((row, r) =>
    row.map((cell, c) => (cell ? text([50, 120, 160][c], 700 - r * 14, cell) : '')),
  )
  .join('\n');

describe('table detection', () => {
  it('TABLE-01: ruled grid with a merged header and a multi-line cell', async () => {
    const page = (await extract([ruled])).pages[0];
    expect(page.tables).toHaveLength(1);
    const [table] = page.tables;
    expect(table).toMatchObject({ detection: 'ruled', rowCount: 4, columnCount: 3 });
    expect(table.bbox).toEqual({ x: 50, y: 100, width: 350, height: 100 });
    expect(table.cells.map((c) => [c.row, c.column, c.rowSpan, c.columnSpan, c.text])).toEqual([
      [0, 0, 1, 1, 'Fruit'],
      [0, 1, 1, 2, 'Stock'],
      [1, 0, 1, 1, 'Name'],
      [1, 1, 1, 1, 'Qty'],
      [1, 2, 1, 1, 'Price'],
      [2, 0, 1, 1, 'Apple'],
      [2, 1, 1, 1, '3'],
      [2, 2, 1, 1, '1.20'],
      [3, 0, 1, 1, 'Banana\nbread'],
      [3, 1, 1, 1, '12'],
      [3, 2, 1, 1, '4.50'],
    ]);
    expect(table.cells[1].bbox).toEqual({ x: 200, y: 100, width: 200, height: 20 });
    expect(page.fullText).toBe(
      'Inventory\n\nFruit\tStock\t\nName\tQty\tPrice\nApple\t3\t1.20\nBanana bread\t12\t4.50\n\nTotal: 3 items',
    );
    const block = page.blocks.find((b) => b.tableIndex === 0);
    expect(block?.lines).toHaveLength(4);
    expect(block?.lines[3].spans.map((s) => s.text)).toEqual(['Banana', 'bread', '12', '4.50']);
  });
  it('TABLE-02: unruled aligned columns read row by row', async () => {
    const page = (await extract([`${text(50, 740, 'Prices this week')}\n${tight}`])).pages[0];
    expect(page.tables).toHaveLength(1);
    expect(page.tables[0]).toMatchObject({ detection: 'aligned', rowCount: 4, columnCount: 3 });
    expect(page.tables[0].cells.filter((c) => c.row === 3).map((c) => c.text)).toEqual([
      'Kiwi',
      '',
      '0.80',
    ]);
    expect(page.fullText).toBe(
      'Prices this week\n\nName\tQty\tPrice\nApple\t3\t1.20\nBanana bread\t12\t4.50\nKiwi\t\t0.80',
    );
  });
  it('TABLE-03: two columns between horizontal rules (booktabs style)', async () => {
    const rows = [
      ['Metric', 'Value'],
      ['Speed', '12 km/h'],
      ['Weight', '4 kg'],
    ];
    const content = [
      ...[712, 694, 654].map((y) => line(45, y, 260, y)),
      ...rows.flatMap((row, r) => row.map((cell, c) => text([50, 200][c], 700 - r * 20, cell))),
    ].join('\n');
    const page = (await extract([content])).pages[0];
    expect(page.tables).toHaveLength(1);
    expect(page.tables[0]).toMatchObject({ detection: 'aligned', rowCount: 3, columnCount: 2 });
    expect(page.fullText).toBe('Metric\tValue\nSpeed\t12 km/h\nWeight\t4 kg');
  });
  it('TABLE-04: prose columns and a framed page are not tables', async () => {
    const sentences = [
      'text set in narrow columns',
      'keeps a steady line width',
      'and reads like the prose',
      'of a newsletter, not cells',
    ];
    const content = [
      line(20, 20, 580, 20),
      line(580, 20, 580, 780),
      line(580, 780, 20, 780),
      line(20, 780, 20, 20),
      line(20, 750, 580, 750),
      ...[40, 230, 420].flatMap((x) => sentences.map((s, i) => text(x, 700 - i * 12, s))),
    ].join('\n');
    const page = (await extract([content])).pages[0];
    expect(page.tables).toEqual([]);
    expect(page.blocks.map((b) => b.text)).toEqual([
      sentences.join('\n'),
      sentences.join('\n'),
      sentences.join('\n'),
    ]);
  });
  it('TABLE-05: tables: false skips detection but keeps each row on one line', async () => {
    const page = (await extract([tight], { tables: false })).pages[0];
    expect(page.tables).toEqual([]);
    expect(page.blocks.every((b) => b.tableIndex === undefined)).toBe(true);
    const lines = page.fullText.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines.map((l) => l.split(/\s+/)[0])).toEqual(['Name', 'Apple', 'Banana', 'Kiwi']);
    await expect(extract([tight], { tables: 'yes' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
  it('TABLE-06: ruling lines follow page rotation', async () => {
    const page = (await extract([ruled], {}, '/Rotate 90')).pages[0];
    expect(page.tables).toHaveLength(1);
    expect(page.tables[0]).toMatchObject({ detection: 'ruled', rowCount: 3, columnCount: 4 });
  });
  it('TABLE-07: white or clipped-away lines are not ruling lines; too many lines degrade', async () => {
    // A 3×3 text grid that reads as an aligned table without ruling lines.
    const cells = [
      ['Part', 'Qty', 'Price'],
      ['Bolt', '12', '0.40'],
      ['Nut', '30', '0.15'],
    ]
      .flatMap((row, r) => row.map((cell, c) => text(55 + c * 100, 686 - r * 20, cell)))
      .join('\n');
    const grid = [
      ...[700, 680, 660, 640].map((y) => `50 ${y - 0.5} 300 1 re f`),
      ...[50, 150, 250, 350].map((x) => `${x - 0.5} 640 1 60 re f`),
    ].join('\n');
    const detection = async (content: string) => {
      const page = (await extract([content])).pages[0];
      return { detection: page.tables.map((t) => t.detection), warnings: page.warnings };
    };
    expect(await detection(`0 g\n${grid}\n${cells}`)).toEqual({
      detection: ['ruled'],
      warnings: [],
    });
    expect((await detection(`1 g\n${grid}\n0 g\n${cells}`)).detection).toEqual(['aligned']);
    expect((await detection(`q 400 100 10 10 re W n\n${grid}\nQ\n${cells}`)).detection).toEqual([
      'aligned',
    ]);
    const hatching = Array.from({ length: 5001 }, (_, i) =>
      line(20, 20 + (i % 50) * 0.1, 30, 20 + (i % 50) * 0.1),
    ).join('\n');
    const { warnings } = await detection(`${hatching}\n${grid}\n${cells}`);
    expect(warnings.map((w) => w.code)).toEqual(['TABLE_DETECTION_DEGRADED']);
  });
  it('TABLE-08: cached ruling lines give the same tables, also after listing images', async () => {
    const pdf = await openPdf(pdfWithText([ruled, tight]));
    try {
      const first = await pdf.getStructuredText();
      expect(first.pages.map((p) => p.tables.length)).toEqual([1, 1]);
      // The second call reads the cached ruling lines of the first.
      expect(await pdf.getStructuredText()).toEqual(first);
      await pdf.getImages();
      expect(await pdf.getStructuredText()).toEqual(first);
    } finally {
      await pdf.close();
    }
    const fresh = await openPdf(pdfWithText([ruled, tight]));
    try {
      await fresh.getImages();
      expect((await fresh.getStructuredText()).pages.map((p) => p.tables)).toEqual(
        (await extract([ruled, tight])).pages.map((p) => p.tables),
      );
    } finally {
      await fresh.close();
    }
  });
  it('TABLE-09: a small maxCachedRuleLines evicts pages without changing tables', async () => {
    const pages = [ruled, tight, ruled];
    const expected = (await extract(pages)).pages.map((p) => p.tables);
    // Room for the 9 lines of one ruled page: the third page evicts the first.
    const pdf = await openPdf(pdfWithText(pages), { limits: { maxCachedRuleLines: 10 } });
    try {
      for (let round = 0; round < 2; round++)
        expect((await pdf.getStructuredText()).pages.map((p) => p.tables)).toEqual(expected);
    } finally {
      await pdf.close();
    }
    for (const maxCachedRuleLines of [0, -1, 1.5])
      await expect(
        openPdf(pdfWithText([ruled]), { limits: { maxCachedRuleLines } }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

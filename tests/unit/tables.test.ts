import { describe, expect, it } from 'vitest';
import type { TextSpan } from '../../packages/core/src/contracts.js';
import { detectTables, mayContainTable, type Rule } from '../../packages/core/src/tables.js';

/** A native span at top-left page coordinates; 10 pt text by default (11.17 pt tall). */
function span(x: number, y: number, text: string, height = 11.17): TextSpan {
  const width = text.length * height * 0.45;
  return {
    text,
    bbox: { x, y, width, height },
    quad: [x, y, x + width, y, x + width, y + height, x, y + height],
    source: 'native',
  };
}
const horizontal = (y: number, x1: number, x2: number, width = 0.5): Rule => ({
  x1,
  y1: y,
  x2,
  y2: y,
  width,
});
const vertical = (x: number, y1: number, y2: number, width = 0.5): Rule => ({
  x1: x,
  y1,
  x2: x,
  y2,
  width,
});
/** Ruling lines of a grid with the given column and row edges. */
function grid(xs: number[], ys: number[]): Rule[] {
  return [
    ...ys.map((y) => horizontal(y, xs[0], xs[xs.length - 1])),
    ...xs.map((x) => vertical(x, ys[0], ys[ys.length - 1])),
  ];
}
const summary = (spans: TextSpan[], rules: Rule[]) =>
  detectTables(spans, rules).map(({ table }) => ({
    detection: table.detection,
    rows: table.rowCount,
    columns: table.columnCount,
  }));

describe('mayContainTable', () => {
  it('ignores a lone split row such as a header with a page number', () => {
    const page = [
      span(50, 30, 'Annual report'),
      span(520, 30, '17'),
      ...Array.from({ length: 30 }, (_, i) => span(50, 60 + i * 14, 'lorem ipsum dolor sit amet')),
    ];
    expect(mayContainTable(page)).toBe(false);
  });
  it('accepts a row of three segments', () => {
    expect(
      mayContainTable([span(50, 100, 'Part'), span(150, 100, 'Qty'), span(250, 100, 'Price')]),
    ).toBe(true);
  });
  it('accepts two split rows with left- or right-aligned second segments', () => {
    expect(
      mayContainTable([
        span(50, 100, 'Name'),
        span(200, 100, 'Qty'),
        span(50, 114, 'Apple'),
        span(203, 114, '3'),
      ]),
    ).toBe(true);
    // Right-aligned numbers: different starts, same right edge.
    expect(
      mayContainTable([
        span(50, 100, 'Total'),
        span(200, 100, '1,234.56'),
        span(50, 114, 'Tax'),
        span(225, 114, '3.00'),
      ]),
    ).toBe(true);
  });
});

describe('detectTables', () => {
  it('rejects a chart grid whose cells mostly hold no text, and axis-labelled grids', () => {
    const rules = grid([100, 233, 366, 500], [100, 200, 300, 400]);
    const plot = [span(150, 120, 'Series A'), span(250, 130, 'peak'), span(400, 330, 'Series B')];
    expect(summary(plot, rules)).toEqual([]);
    // Every cell labelled, but every line carries an axis label left of the grid.
    const cells = [0, 1, 2].flatMap((r) =>
      [0, 1, 2].map((c) => span(110 + c * 133, 140 + r * 100, `v${r}${c}`)),
    );
    const axis = [100, 200, 300, 400].map((y) => span(70, y - 5.5, String(y)));
    expect(summary([...cells, ...axis], rules)).toEqual([]);
    expect(summary(cells, rules)).toEqual([{ detection: 'ruled', rows: 3, columns: 3 }]);
  });
  it('reads a bulleted list with aligned references as a list, not a table', () => {
    const rows = Array.from({ length: 6 }, (_, i) => [
      span(60, 100 + i * 14, '•'),
      span(80, 100 + i * 14, `item ${i}`),
      span(300, 100 + i * 14, `see p. ${i}`),
      span(450, 100 + i * 14, 'ok'),
    ]).flat();
    expect(summary(rows, [])).toEqual([]);
    // The same rows with a code column instead of bullets remain a table.
    const coded = rows.map((s) => (s.text === '•' ? { ...s, text: 'A7' } : s));
    expect(summary(coded, [])).toEqual([{ detection: 'aligned', rows: 6, columns: 4 }]);
  });
  it('scales grid distances with the text: fine print', () => {
    // 3 pt text in rows 4 pt apart: closer than the 4 pt snap distance of 10 pt text.
    const xs = [50, 80, 110, 140],
      ys = [100, 104, 108, 112];
    const cells = [0, 1, 2].flatMap((r) =>
      [0, 1, 2].map((c) => span(xs[c] + 2, ys[r] + 0.3, `c${r}${c}`, 3.35)),
    );
    expect(summary(cells, grid(xs, ys))).toEqual([{ detection: 'ruled', rows: 3, columns: 3 }]);
  });
  it('scales grid distances with the text: large type keeps a doubled border as one line', () => {
    // 24 pt text; the outer border is doubled 6 pt apart. At this size the scaled snap distance
    // joins both lines into the grid's edge instead of adding thin empty rows and columns.
    const xs = [50, 250, 450, 650],
      ys = [100, 140, 180, 220];
    const cells = [0, 1, 2].flatMap((r) =>
      [0, 1, 2].map((c) => span(xs[c] + 10, ys[r] + 6, `c${r}${c}`, 26.8)),
    );
    const doubled = [
      ...grid(xs, ys),
      horizontal(94, 44, 656),
      horizontal(226, 44, 656),
      vertical(44, 94, 226),
      vertical(656, 94, 226),
    ];
    expect(summary(cells, doubled)).toEqual([{ detection: 'ruled', rows: 3, columns: 3 }]);
  });
  it('keeps two ruled tables side by side, without reading cells as axis labels', () => {
    const table = (x0: number) => {
      const xs = [x0, x0 + 60, x0 + 120],
        ys = [100, 114, 128, 142];
      return {
        rules: grid(xs, ys),
        spans: [0, 1, 2].flatMap((r) =>
          [0, 1].map((c) => span(xs[c] + 3, ys[r] + 1.5, `r${r}c${c}`)),
        ),
      };
    };
    const left = table(50),
      right = table(185);
    expect(summary([...left.spans, ...right.spans], [...left.rules, ...right.rules])).toEqual([
      { detection: 'ruled', rows: 3, columns: 2 },
      { detection: 'ruled', rows: 3, columns: 2 },
    ]);
  });
  it('reads a table with numbered rows as a table', () => {
    const rows = Array.from({ length: 5 }, (_, i) => [
      span(50, 100 + i * 14, `${i + 1}.`),
      span(100, 100 + i * 14, `Item ${i}`),
      span(250, 100 + i * 14, `${i * 3}`),
      span(350, 100 + i * 14, `${i}.50`),
    ]).flat();
    expect(summary(rows, [])).toEqual([{ detection: 'aligned', rows: 5, columns: 4 }]);
  });
  it('measures a fine-print ruled table by its own text on a page of body text', () => {
    // Rows 3.6 pt apart: within the 4 pt snap distance of the page's 10 pt body text.
    const xs = [50, 80, 110, 140],
      ys = [600, 603.6, 607.2, 610.8];
    const cells = [0, 1, 2].flatMap((r) =>
      [0, 1, 2].map((c) => span(xs[c] + 2, ys[r] + 0.3, `c${r}${c}`, 3.35)),
    );
    const body = Array.from({ length: 40 }, (_, i) =>
      span(50, 60 + i * 13, 'body text set in ten point type'),
    );
    expect(summary([...body, ...cells], grid(xs, ys))).toEqual([
      { detection: 'ruled', rows: 3, columns: 3 },
    ]);
  });
});

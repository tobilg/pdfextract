import { describe, expect, it } from 'vitest';
import type { TextSpan } from '../../packages/core/src/contracts.js';
import {
  detectTables,
  mayContainTable,
  type Rule,
  splitAtRules,
} from '../../packages/core/src/tables.js';

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

describe('detectTables: shaded cells, rule bands, lists and contents', () => {
  /** Edges of a shaded rectangle (a cell background), as the engine reports them. */
  const shade = (x1: number, y1: number, x2: number, y2: number): Rule[] => [
    { ...horizontal(y1, x1, x2), fill: true },
    { ...horizontal(y2, x1, x2), fill: true },
    { ...vertical(x1, y1, y2), fill: true },
    { ...vertical(x2, y1, y2), fill: true },
  ];
  const cells = (xs: number[], ys: number[], text: (r: number, c: number) => string) =>
    ys.slice(0, -1).flatMap((y, r) =>
      xs.slice(0, -1).flatMap((x, c) => {
        const value = text(r, c);
        return value ? [span(x + 4, y + 3, value)] : [];
      }),
    );

  it('reads a grid of shaded cells as a table', () => {
    const xs = [50, 170, 290, 410],
      ys = [100, 120, 140, 160];
    // Each cell is shaded, with a white gap between cells; no line is drawn.
    const rules = ys
      .slice(0, -1)
      .flatMap((y, r) =>
        xs.slice(0, -1).flatMap((x, c) => shade(x + 1, y + 1, xs[c + 1] - 1, ys[r + 1] - 1)),
      );
    const text = cells(xs, ys, (r, c) => `R${r}C${c}`);
    expect(summary(text, rules)).toEqual([{ detection: 'ruled', rows: 3, columns: 3 }]);
  });

  it('keeps a drawn grid over a coarser one outlined by shading of the same text', () => {
    const xs = [50, 170, 290],
      ys = [100, 120, 140, 160];
    const text = cells(xs, ys, (r, c) => `R${r}C${c}`);
    // A shaded header and a shaded body: two bands where the drawn lines give three rows.
    const rules = [...grid(xs, ys), ...shade(50, 100, 290, 120), ...shade(50, 120, 290, 160)];
    expect(summary(text, rules)).toEqual([{ detection: 'ruled', rows: 3, columns: 2 }]);
  });

  it('reads a booktabs table whose second column is empty below the header', () => {
    const rows = ['Added cation', 'K+', 'Na+', 'Ca2+', 'Al3+', 'Check'];
    const text = [
      span(60, 104, 'Added cation'),
      span(130, 104, 'Relative settling rate'),
      ...rows.slice(1).map((row, i) => span(60, 122 + i * 16, row)),
    ];
    const rules = [horizontal(100, 56, 300), horizontal(122 + 5 * 16, 56, 300)];
    expect(summary(text, rules)).toEqual([{ detection: 'aligned', rows: 6, columns: 2 }]);
  });

  it('does not read values between two rules under a numeric header as a table', () => {
    // Chart value labels: a row of numbers, then single values, framed by two gridlines.
    const text = [
      span(60, 104, '2019'),
      span(160, 104, '2020'),
      ...[20, 35, 50].map((value, i) => span(60, 122 + i * 16, String(value))),
    ];
    const rules = [horizontal(100, 56, 300), horizontal(122 + 3 * 16, 56, 300)];
    expect(summary(text, rules)).toEqual([]);
  });

  it('reads a stack of boxed short entries as a one-column table, but not boxed paragraphs', () => {
    const xs = [50, 350],
      ys = [100, 120, 140, 160, 180, 200];
    const entries = cells(xs, ys, (r) => `#${r + 1}: Competence area ${r + 1}`);
    expect(summary(entries, grid(xs, ys))).toEqual([{ detection: 'ruled', rows: 5, columns: 1 }]);
    const paragraphs = cells(xs, ys, () => 'lorem ipsum dolor sit amet '.repeat(6).trim());
    expect(summary(paragraphs, grid(xs, ys))).toEqual([]);
  });

  it('reads a fill-in worksheet with an empty body as a table', () => {
    const xs = [50, 200, 320, 440],
      ys = [100, 120, 140, 160, 180];
    const labels = ['', 'Mitosis', 'Meiosis'];
    const text = cells(xs, ys, (r, c) => (r === 0 ? labels[c] : c === 0 ? `# property ${r}` : ''));
    expect(summary(text, grid(xs, ys))).toEqual([{ detection: 'ruled', rows: 4, columns: 3 }]);
  });

  it('does not read a table of contents (ascending page numbers) as a table', () => {
    const entries = ['Front Matter', 'Introduction', 'Our Mental Shortcuts', 'Identifying a Topic'];
    const text = entries.flatMap((entry, i) => [
      span(60, 100 + i * 16, `${i + 1}.`),
      span(90, 100 + i * 16, entry),
      span(400, 100 + i * 16, String(1 + i * 9)),
    ]);
    expect(summary(text, [])).toEqual([]);
  });
});

describe('detectTables: small grids, finer grids in rules, contents', () => {
  it('TABLE-11: two rows of figures across five columns are a table', () => {
    const rows = [
      ['Q3', '0.84', '0.74', '22%', '14%'],
      ['9 Months', '2.44', '2.12', '20%', '15%'],
    ];
    const xs = [50, 120, 160, 200, 260];
    const spans = rows.flatMap((row, r) => row.map((t, c) => span(xs[c], 100 + r * 14, t)));
    expect(summary(spans, [])).toEqual([{ detection: 'aligned', rows: 2, columns: 5 }]);
  });
  it('TABLE-12: two columns of short entries are a table; a sidebar beside prose is not', () => {
    const people = [
      ['Mick Heduan', 'Transport for London'],
      ['Edward Noble', 'LB Merton'],
      ['David Kennett', 'LB Wandsworth'],
      ['Roseline Holt', 'Sainsburys'],
      ['Richard Kingsbury', 'LB Sutton'],
    ];
    const list = people.flatMap(([name, place], r) => [
      span(72, 100 + r * 14, name),
      span(250, 100 + r * 14, place),
    ]);
    expect(summary(list, [])).toEqual([{ detection: 'aligned', rows: 5, columns: 2 }]);
    const sidebar = [
      'In this',
      'context, we are',
      'talking about',
      'fact-checking',
      'that is done',
    ];
    const prose = [
      'article or book) are correct. For',
      'example, they may contact a person',
      'who is quoted in a proposed news',
      'article and ask the person whether',
      'this quotation is correct, or how to',
    ];
    const side = sidebar.flatMap((t, r) => [
      span(72, 300 + r * 14, t),
      span(200, 300 + r * 14, prose[r]),
    ]);
    expect(summary(side, [])).toEqual([]);
  });
  it('TABLE-13: rules around groups of cells give way to the aligned grid inside', () => {
    // A box per district, each holding a name column and a value column without rules.
    const rules = grid([40, 200, 360], [90, 160]);
    const cells = [
      ['Jagger', '23.0', 'Jagger', '23.6'],
      ['TAM 107', '13.5', '2137', '16.0'],
      ['2137', '12.9', 'Karl 92', '12.2'],
      ['Trego', '7.5', 'Dominator', '6.5'],
    ];
    const xs = [45, 150, 205, 310];
    const spans = cells.flatMap((row, r) => row.map((t, c) => span(xs[c], 95 + r * 15, t)));
    const [found] = detectTables(spans, rules);
    expect([found.table.rowCount, found.table.columnCount]).toEqual([4, 4]);
    expect(found.table.cells.find((c) => c.row === 3 && c.column === 1)?.text).toBe('7.5');
  });
  it('TABLE-14: contents with Roman front-matter pages are not a table', () => {
    const entries = [
      ['Acknowledgment of Country', 'v'],
      ['Accessibility Information', 'vi'],
      ['Acknowledgments', 'vii'],
      ['About the Authors', 'viii'],
      ['Introduction', '1'],
      ['Methods', '9'],
    ];
    const spans = entries.flatMap(([title, page], r) => [
      span(72, 100 + r * 14, title),
      span(500, 100 + r * 14, page),
    ]);
    expect(summary(spans, [])).toEqual([]);
  });
  const texts = (found: ReturnType<typeof detectTables>[number]) =>
    Array.from({ length: found.table.rowCount }, (_, r) =>
      found.table.cells.filter((c) => c.row === r).map((c) => c.text),
    );
  it('TABLE-15: labels beside a ruled value column are one cell per row; shading slivers go', () => {
    // Values in boxes whose shading sits 2 pt inside the borders (extra grid lines at 202 and
    // 358); the label column has no row rules.
    const ys = [100, 115, 130, 145];
    const rules = [
      ...grid([40, 200, 360], [ys[0], ys[3]]),
      ...ys.map((y) => horizontal(y, 200, 360)),
      vertical(202, ys[0], ys[3]),
      vertical(358, ys[0], ys[3]),
    ];
    const rows = [
      ['Registration', '50'],
      ['Examination', '710'],
      ['Re-examination', '485'],
    ];
    const spans = rows.flatMap(([label, value], r) => [
      span(45, ys[r] + 2, label),
      span(210, ys[r] + 2, value),
    ]);
    const [found] = detectTables(spans, rules);
    expect(found.table.detection).toBe('ruled');
    expect(texts(found)).toEqual(rows);
  });
  it('TABLE-16: a label row between rows alike continues an aligned table', () => {
    const row = (y: number, label: string, a: string, b: string) => [
      span(50, y, label),
      span(250, y, a),
      span(350, y, b),
    ];
    const spans = [
      ...row(100, 'Staff', 'Count', 'Percent'),
      ...row(114, 'Total Staff', '72.0', '100.0%'),
      ...row(128, 'Teachers', '53.0', '73.6%'),
      span(50, 152, 'Teachers by Sex:'),
      ...row(166, 'Males', '5.0', '9.4%'),
      ...row(180, 'Females', '48.0', '90.6%'),
      // A chart's axis value is no label: the table ends above it.
      span(50, 204, '600'),
      ...row(218, '2014', '2015', '2016'),
      ...row(232, '500', '450', '400'),
    ];
    const found = detectTables(spans, []);
    expect(texts(found[0]).map((r) => r[0])).toEqual([
      'Staff',
      'Total Staff',
      'Teachers',
      'Teachers by Sex:',
      'Males',
      'Females',
    ]);
    expect(texts(found[0])[3]).toEqual(['Teachers by Sex:', '', '']);
  });
  it('TABLE-17: lines of short cells between a mid and a bottom rule are rows', () => {
    const rules = [100, 125, 190].map((y) => horizontal(y, 40, 400));
    const header = [span(45, 105, 'Level'), span(150, 105, '[CO]'), span(250, 105, '[NO]')];
    const body = ['Control', 'Low', 'Medium', 'High'].flatMap((level, r) => [
      span(45, 130 + r * 14, level),
      span(150, 130 + r * 14, `${r * 250} uM`),
      span(250, 130 + r * 14, `${r * 0.002} nM`),
    ]);
    const [found] = detectTables([...header, ...body], rules);
    expect(found.table.rowCount).toBe(5);
    expect(texts(found)[2]).toEqual(['Low', '250 uM', '0.002 nM']);
  });
  it('TABLE-18: a run written across a column rule splits there', () => {
    const rules = grid([40, 72, 200], [100, 115, 130, 145]);
    const runs = ['1 Increase', '2 Decrease', '3 Increase'].map((t, r) =>
      span(60, 102 + r * 15, t),
    );
    const parts = new Map<TextSpan, TextSpan>();
    const split = splitAtRules(runs, rules, parts);
    expect(split.map((s) => s.text)).toEqual(['1', 'Increase', '2', 'Decrease', '3', 'Increase']);
    expect(parts.get(split[1])).toBe(runs[0]);
    const [found] = detectTables(split, rules);
    expect(texts(found)).toEqual([
      ['1', 'Increase'],
      ['2', 'Decrease'],
      ['3', 'Increase'],
    ]);
    // Text crossing no rule is returned as is.
    expect(splitAtRules(runs, [], parts)).toBe(runs);
  });
  it('TABLE-19: a caption row starts the next table', () => {
    // Two tables one row apart; the caption row of the second also holds the running header.
    const row = (y: number, xs: number[], cells: string[]) =>
      cells.map((t, c) => span(xs[c], y, t));
    const a = [50, 150, 250],
      b = [50, 120, 300];
    const spans = [
      ...row(100, a, ['Case', 'Onset', 'Comment']),
      ...[1, 2, 3].flatMap((r) => row(100 + r * 14, a, [`${r}`, `${r} days`, 'Elective'])),
      span(50, 156, 'Table 2 Prematurity'),
      span(450, 156, 'Fifth day fits 755'),
      ...row(170, b, ['Case', 'Weight', 'Gestation']),
      ...[36, 34, 40].flatMap((weeks, r) =>
        row(184 + r * 14, b, [`${r + 10}`, `${2400 + r}`, `${weeks}`]),
      ),
    ];
    const found = detectTables(spans, []);
    expect(found.map((t) => texts(t)[0])).toEqual([
      ['Case', 'Onset', 'Comment'],
      ['Case', 'Weight', 'Gestation'],
    ]);
  });
  it('TABLE-20: a ruled cell holding a column of figures holds rows; wrapped text does not', () => {
    // Rules around the two columns only: each ruled cell holds one line per row.
    const rules = grid([40, 200, 360], [96, 160]);
    const rows = [
      ['Wheat', '12'],
      ['Barley', '15'],
      ['Oats', '9'],
      ['Rye', '4'],
    ];
    const spans = rows.flatMap(([label, value], r) => [
      span(45, 100 + r * 14, label),
      span(210, 100 + r * 14, value),
    ]);
    const [found] = detectTables(spans, rules);
    expect(texts(found)).toEqual(rows);
    // A ruled row whose label wraps over two lines beside one-line values stays one row.
    const wrapped = grid([40, 140, 240, 340], [96, 130, 160]);
    const cells = [
      span(45, 100, 'Radius to'),
      span(45, 114, 'maximum winds'),
      span(145, 100, 'Speed'),
      span(245, 100, 'Pressure'),
      span(45, 135, '27.6'),
      span(145, 135, '5.7'),
      span(245, 135, '940'),
    ];
    const [kept] = detectTables(cells, wrapped);
    expect(texts(kept)).toEqual([
      ['Radius to\nmaximum winds', 'Speed', 'Pressure'],
      ['27.6', '5.7', '940'],
    ]);
  });
  it('TABLE-21: words of a scan layer set a word per span keep their cells', () => {
    // The invisible text of a scan: each word its own span, words 0.7 em apart, cells 60 pt.
    const spans: TextSpan[] = [];
    for (let r = 0; r < 12; r++) {
      const y = 100 + r * 14;
      let x = 50;
      for (const cell of [
        [`${r + 1}`, 'days'],
        [`${r + 2}`, 'hours'],
        ['Case', `${r}`],
      ]) {
        for (const word of cell) {
          const s = span(x, y, word);
          spans.push(s);
          x += s.bbox.width + 0.7 * 11.17;
        }
        x += 60;
      }
    }
    const [found] = detectTables(spans, []);
    expect(found.table.columnCount).toBe(3);
    expect(texts(found)[0]).toEqual(['1 days', '2 hours', 'Case 0']);
    // Values with units fill their column as lines of words would: they are no prose.
    const values = [
      ['Case', 'Onset of fits', 'Duration', 'Comment'],
      ...['3 days 5 hours', '4 days 6 hours', '3 days 9 hours', '5 days 2 hours'].map(
        (onset, r) => [
          `${r + 8}`,
          onset,
          `${r * 7 + 12} hours`,
          ['Elective', 'Fibroid', 'Unstable lie', 'Previous section'][r],
        ],
      ),
    ].flatMap((row, r) => row.map((text, c) => span([40, 75, 160, 235][c], 100 + r * 14, text)));
    expect(summary(values, [])).toEqual([{ detection: 'aligned', rows: 5, columns: 4 }]);
  });
  it('TABLE-22: prose between two rules is no table; long text cells under column names are', () => {
    // A page's two columns between its header rule and its footer rule.
    const left = [
      'The assay has a number of significant benefits',
      'over other assays for counting the cells, and',
      'it is linear from fifty cells to fifty thousand',
      'cells in a sample of two hundred microlitres.',
    ];
    const right = [
      'Murine fibroblasts and myeloma cells were used',
      'to test the method on cells grown in culture,',
      'and the results agreed with counts made by the',
      'standard method in every one of the samples.',
    ];
    const page = [
      ...left.map((text, i) => span(50, 60 + i * 14, text)),
      ...right.map((text, i) => span(300, 60 + i * 14, text)),
    ];
    const frame = [horizontal(50, 40, 560), horizontal(130, 40, 560)];
    expect(summary(page, frame)).toEqual([]);
    // A justified box: its first line spread out word by word, the others lines of words.
    const first = ['cotización', 'completo', 'de', 'las', 'mujeres'];
    const box = [
      ...first.map((word, i) => span(300 + i * 56, 204, word)),
      ...[
        'período de cotización requerido para',
        'que las mujeres reciban una pensión',
        'completa aumentará gradualmente de',
        'treinta y dos años y cuatro meses a',
      ].map((text, i) => span(300, 218 + i * 14, text)),
    ];
    expect(summary(box, [horizontal(200, 296, 590), horizontal(280, 296, 590)])).toEqual([]);
    // A booktabs table with column names over lines of explanation is a table.
    const table = [
      ...['Stage', 'Function', 'Explanation', 'Expected Benefit'].map((name, c) =>
        span([50, 110, 190, 420][c], 304, name),
      ),
      ...[
        ['1. Create', 'Projects', 'Select a document type to create', 'Quick setup for'],
        ['', '', 'a project with a recommended model', 'the whole process'],
        ['2. Label', 'Storage', 'Upload raw data and manage it with', 'Raw data in one'],
        ['', '', 'search, sorting and filtering tools', 'place for labels'],
      ].flatMap((row, r) =>
        row.flatMap((text, c) => (text ? [span([50, 110, 190, 420][c], 322 + r * 14, text)] : [])),
      ),
    ];
    expect(summary(table, [horizontal(300, 40, 590), horizontal(380, 40, 590)])).toEqual([
      { detection: 'aligned', rows: 5, columns: 4 },
    ]);
  });
});

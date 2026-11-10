import { describe, expect, it } from 'vitest';
import type { StructuredText, TextBlock } from '../../packages/core/src/contracts.js';
import { toMarkdown } from '../../packages/core/src/markdown.js';

const box = { x: 0, y: 0, width: 1, height: 1 };
const block = (...lines: string[]): TextBlock => ({
  text: lines.join('\n'),
  bbox: box,
  lines: lines.map((text) => ({ text, bbox: box, spans: [] })),
});
const document = (...blocks: TextBlock[]): StructuredText => ({
  schemaVersion: 1,
  status: 'complete',
  pageCount: 1,
  fullText: blocks.map((b) => b.text).join('\n\n'),
  warnings: [],
  pages: [
    {
      pageNumber: 1,
      width: 1,
      height: 1,
      rotation: 0,
      fullText: '',
      blocks,
      tables: [],
      ocrStatus: 'disabled',
      warnings: [],
    },
  ],
});

const page = (blocks: TextBlock[], tables: StructuredText['pages'][0]['tables']) => {
  const text = document(...blocks);
  text.pages[0].tables = tables;
  return text;
};
const at = (row: number, column: number, text: string, rowSpan = 1, columnSpan = 1) => ({
  row,
  column,
  rowSpan,
  columnSpan,
  text,
  bbox: box,
});

describe('toMarkdown', () => {
  it('MD-02: tables with merged cells are HTML tables; others pipe tables, or as chosen', () => {
    const grouped = {
      bbox: box,
      rowCount: 3,
      columnCount: 3,
      detection: 'aligned' as const,
      // A group header over two columns names them in the row below: both rows are header.
      cells: [
        at(0, 0, 'Item', 2),
        at(0, 1, 'Percent', 1, 2),
        at(1, 1, '2019'),
        at(1, 2, '2020 <est>'),
        at(2, 0, 'Wheat & rye'),
        at(2, 1, '12'),
        at(2, 2, '14'),
      ],
    };
    const plain = {
      ...grouped,
      rowCount: 2,
      columnCount: 2,
      cells: [at(0, 0, 'A'), at(0, 1, 'B'), at(1, 0, '1'), at(1, 1, '2')],
    };
    const text = page(
      [
        { ...block('x'), tableIndex: 0 },
        { ...block('y'), tableIndex: 1 },
      ],
      [grouped, plain],
    );
    expect(toMarkdown(text)).toBe(
      [
        '<table>',
        '<tr><th rowspan="2">Item</th><th colspan="2">Percent</th></tr>',
        '<tr><th>2019</th><th>2020 &lt;est&gt;</th></tr>',
        '<tr><th>Wheat &amp; rye</th><td>12</td><td>14</td></tr>',
        '</table>',
        '',
        '| A | B |',
        '| --- | --- |',
        '| 1 | 2 |',
      ].join('\n'),
    );
    expect(toMarkdown(text, { tables: 'pipe' })).toContain('| Item | Percent |  |');
    expect(toMarkdown(text, { tables: 'html' })).toContain('<tr><th>A</th><th>B</th></tr>');
    // A lone label over the column names: the row of names is header too.
    const labelled = {
      ...plain,
      rowCount: 3,
      columnCount: 3,
      cells: [
        ...[at(0, 0, ''), at(0, 1, 'Model'), at(0, 2, '')],
        ...[at(1, 0, 'Province'), at(1, 1, '8'), at(1, 2, '9')],
        ...[at(2, 0, 'Adana'), at(2, 1, '1'), at(2, 2, '1')],
      ],
    };
    expect(
      toMarkdown(page([{ ...block('z'), tableIndex: 0 }], [labelled]), { tables: 'html' }),
    ).toBe(
      [
        '<table>',
        '<tr><th></th><th>Model</th><th></th></tr>',
        '<tr><th>Province</th><th>8</th><th>9</th></tr>',
        '<tr><th>Adana</th><td>1</td><td>1</td></tr>',
        '</table>',
      ].join('\n'),
    );
  });

  it('MD-01: a block of rules typed as text is a thematic break; a rule among text stays text', () => {
    expect(toMarkdown(document(block('Stable in normal conditions.'), block('_'.repeat(60))))).toBe(
      'Stable in normal conditions.\n\n---',
    );
    // Below a text line, --- would make that line a heading: it stays escaped.
    expect(toMarkdown(document(block('Total', '-----')), { lines: 'preserve' })).toBe(
      'Total\n\\-----',
    );
  });

  it('MD-03: an inline formula broken at a line end is one formula', () => {
    // The first half ends in a relation, or the second starts with one: one formula. Two
    // formulas that are complete stay two.
    expect(
      toMarkdown(
        document(
          block('so that $I^{+}(p)=$', '$I^{+}(q)\\Rightarrow p=q$ holds, and $x$', '$y$ too.'),
        ),
      ),
    ).toBe('so that $I^{+}(p)= I^{+}(q)\\Rightarrow p=q$ holds, and $x$ $y$ too.');
    expect(toMarkdown(document(block('where $a$', '$=b$ holds.')))).toBe('where $a =b$ holds.');
  });
});

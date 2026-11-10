import { describe, expect, it } from 'vitest';
import type { TextBlock, TextPage } from '../../packages/core/src/contracts.js';
import { markFurniture, markRepeatedFurniture } from '../../packages/core/src/furniture.js';
import { toMarkdown } from '../../packages/core/src/markdown.js';

const WIDTH = 612,
  HEIGHT = 792;
/** A block of lines at (x, y) on a US Letter page, 12 pt line pitch in `size` pt type. */
function block(text: string, x: number, y: number, size = 10, extra: Partial<TextBlock> = {}) {
  const lines = text.split('\n').map((line, i) => {
    const bbox = { x, y: y + i * 12, width: line.length * size * 0.5, height: size };
    return {
      text: line,
      bbox,
      spans: [{ text: line, bbox, source: 'native' as const, fontSize: size }],
    };
  });
  const width = Math.max(...lines.map((l) => l.bbox.width));
  return {
    text,
    lines,
    bbox: { x, y, width, height: lines.length * 12 - 2 },
    ...extra,
  } satisfies TextBlock;
}
const body = (y: number) =>
  block(
    [
      'The committee met twice during the quarter to review the budget and the',
      'progress of the three projects that were started in the spring of this year.',
      'Most of the planned work was completed on time and within the agreed costs.',
    ].join('\n'),
    72,
    y,
  );
function page(blocks: TextBlock[], pageNumber = 1): TextPage {
  return {
    pageNumber,
    width: WIDTH,
    height: HEIGHT,
    rotation: 0,
    fullText: blocks.map((b) => b.text).join('\n\n'),
    blocks,
    tables: [],
    ocrStatus: 'disabled',
    warnings: [],
  };
}
const marks = (p: TextPage) => p.blocks.map((b) => b.furniture ?? '-');

describe('furniture', () => {
  it('FURN-01: running headers, journal lines and page numbers at the edges', () => {
    const p = page([
      block('Journal of Applied Studies 12 (2020) 45-67', 72, 30, 8),
      block('Strategic Management', 400, 30, 8),
      body(110),
      body(160),
      block('© 2020 The Authors. Published by Example Press.', 72, 740, 8),
      block('45', 300, 760, 9),
    ]);
    markFurniture(p);
    expect(marks(p)).toEqual(['header', 'header', '-', '-', 'footer', 'footer']);
  });
  it('FURN-02: body text near an edge stays text', () => {
    const p = page([
      // A paragraph continued from the previous page, set apart by a paragraph gap.
      block('was used throughout the study.', 72, 40),
      body(70),
      body(400),
      // A figure caption, an equation number and a footnote at the bottom.
      block('Figure 3. Monthly rainfall at the three stations.', 72, 712, 9),
      block('(15.42)', 520, 735),
      block(
        '2. Note that the same bias also applies to the laboratory experiments\nreported in the second part.',
        72,
        752,
        8,
      ),
    ]);
    markFurniture(p);
    expect(marks(p)).toEqual(['-', '-', '-', '-', '-', '-']);
  });
  it('FURN-03: a title near the top and a full-width line of prose are not furniture', () => {
    const p = page([
      block('A Study of Rainfall', 200, 40, 18, { headingLevel: 1 }),
      block('Results from three stations, measured over twenty years by volunteers.', 72, 80),
      body(140),
    ]);
    markFurniture(p);
    expect(marks(p)).toEqual(['-', '-', '-']);
  });
  it('FURN-04: text repeated at the same height across pages is furniture', () => {
    // Below the single-page zone (15%), with little gap: only repetition reveals it.
    const pages = [1, 2, 3].map((n) =>
      page([body(60), block(`Annual Report ${2020 + n} - Section ${n}`, 72, 112), body(130)], n),
    );
    for (const p of pages) markFurniture(p);
    expect(pages.map((p) => p.blocks[1].furniture)).toEqual([undefined, undefined, undefined]);
    markRepeatedFurniture(pages);
    expect(pages.map((p) => p.blocks[1].furniture)).toEqual(['header', 'header', 'header']);
    expect(pages.map((p) => p.blocks[0].furniture)).toEqual([undefined, undefined, undefined]);
  });
  it('FURN-06: margin stamps, citation lines, page words and short lowercase titles', () => {
    // A download notice set at a quarter turn along the left edge.
    const stamp = block('Downloaded from journals.example.org on 2020-06-28', 12, 200, 8);
    const quad = [12, 500, 12, 200, 20, 200, 20, 500] as const;
    stamp.bbox = { x: 12, y: 200, width: 8, height: 300 };
    stamp.lines[0].bbox = stamp.bbox;
    stamp.lines[0].spans[0] = { ...stamp.lines[0].spans[0], bbox: stamp.bbox, quad: [...quad] };
    const p = page([
      block('ESG 5 - 12', 72, 30, 8),
      body(110),
      body(400),
      stamp,
      block(
        'Please cite this article as: Homer, C., Midwifery (2017), doi:10.1016/j.midw',
        40,
        740,
        8,
      ),
      block('8 | Page', 520, 760, 9),
    ]);
    markFurniture(p);
    expect(marks(p)).toEqual(['header', '-', '-', 'margin', 'footer', 'footer']);
    // A running title set in lowercase near the bottom.
    const q = page([body(110), body(400), block('indlandsisen på grønland 59', 72, 750, 8)]);
    markFurniture(q);
    expect(marks(q)).toEqual(['-', '-', 'footer']);
  });
  it('FURN-07: a sentence at the body size near an edge is text', () => {
    // A short paragraph closing the page, set apart from the text above it.
    const p = page([
      body(110),
      body(400),
      block('Smith [6] showed the following characterization.', 72, 740),
    ]);
    markFurniture(p);
    expect(marks(p)).toEqual(['-', '-', '-']);
  });
  it('FURN-05: Markdown keeps furniture unless asked to leave it out', () => {
    const p = page([block('Example Journal', 72, 30, 8), body(110), block('7', 300, 760, 9)]);
    markFurniture(p);
    const text = {
      schemaVersion: 1 as const,
      status: 'complete' as const,
      pageCount: 1,
      pages: [p],
      fullText: p.fullText,
      warnings: [],
    };
    expect(toMarkdown(text)).toContain('Example Journal');
    const lean = toMarkdown(text, { furniture: false });
    expect(lean).not.toContain('Example Journal');
    expect(lean).not.toMatch(/^7$/m);
    expect(lean).toContain('The committee met twice');
  });
});

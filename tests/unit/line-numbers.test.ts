import { describe, expect, it } from 'vitest';
import type { TextSpan } from '../../packages/core/src/contracts.js';
import { lineNumbers } from '../../packages/core/src/line-numbers.js';

/** A native span at top-left page coordinates in 10 pt type. */
function span(x: number, y: number, text: string, height = 10): TextSpan {
  return { text, bbox: { x, y, width: text.length * height * 0.5, height }, source: 'native' };
}
const prose = 'the three scans were analyzed separately and compared';

describe('lineNumbers', () => {
  it('LINES-01: numbers beside every line of a manuscript, in both margins', () => {
    const spans: TextSpan[] = [];
    for (let k = 0; k < 12; k++) {
      const y = 100 + k * 12;
      spans.push(span(10, y, `${387 + k}`), span(40, y, prose));
      spans.push(span(320, y, prose), span(580, y, `${450 + k}`));
    }
    const found = lineNumbers(spans);
    expect(found.size).toBe(24);
    expect([...found].every((s) => /^\d+$/.test(s.text))).toBe(true);
  });
  it('LINES-02: every fifth line numbered in a patent gutter, some numbers missing', () => {
    const spans: TextSpan[] = [];
    for (let k = 0; k < 60; k++) {
      const y = 100 + k * 10;
      spans.push(span(40, y, prose), span(320, y, prose));
      if (k % 5 === 4 && k !== 19) spans.push(span(300, y, `${k + 1}`, 7));
    }
    expect(lineNumbers(spans).size).toBe(11);
  });
  it('LINES-04: numbers misread in a scan (1O for 10) are line numbers too', () => {
    const spans: TextSpan[] = [];
    for (let k = 0; k < 40; k++) {
      const y = 100 + k * 10;
      spans.push(span(40, y, prose), span(320, y, prose));
      if (k % 5 === 4) spans.push(span(300, y, k === 9 ? '1O' : `${k + 1}`, 7));
    }
    const found = lineNumbers(spans);
    expect(found.size).toBe(8);
    expect([...found].some((s) => s.text === '1O')).toBe(true);
    // Words of such letters alone are none.
    expect(lineNumbers([span(300, 100, 'lO', 7), span(40, 100, prose)]).size).toBe(0);
  });
  it('LINES-03: a table column of row numbers beside short cells stays', () => {
    const spans: TextSpan[] = [];
    for (let k = 0; k < 10; k++) {
      const y = 100 + k * 14;
      spans.push(span(50, y, `${k + 1}`), span(80, y, `Item ${k}`), span(200, y, `${k * 3}`));
    }
    expect(lineNumbers(spans).size).toBe(0);
    // Nor beside a row of figures written as one run, with a column of prose further left.
    const figures: TextSpan[] = [];
    for (let k = 0; k < 10; k++) {
      const y = 100 + k * 14;
      figures.push(span(300, y, `${k + 1}`), span(330, y, `Na ${k}.24 ± 0.12 0.21 0.30`));
      figures.push(span(20, y, 'the samples were compared to a spectral library'));
    }
    expect(lineNumbers(figures).size).toBe(0);
    // Nor booth numbers that start again higher up in a second section.
    const booths: TextSpan[] = [];
    [100, 101, 102, 103, 200, 201, 202, 203].forEach((booth, k) => {
      const y = 100 + k * 14;
      booths.push(
        span(50, y, `${booth}`),
        span(80, y, 'The Kubala Washatko Architects and Partners'),
      );
    });
    expect(lineNumbers(booths).size).toBe(0);
  });
});

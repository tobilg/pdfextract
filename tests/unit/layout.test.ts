import { describe, expect, it } from 'vitest';
import type { TextSpan } from '../../packages/core/src/contracts.js';
import { layout } from '../../packages/core/src/geometry.js';

/** A native span at top-left page coordinates, its width from an average glyph of 0.45 em. */
function span(x: number, y: number, text: string, height = 6.4): TextSpan {
  const width = text.length * height * 0.45;
  return {
    text,
    bbox: { x, y, width, height },
    quad: [x, y, x + width, y, x + width, y + height, x, y + height],
    source: 'native',
  };
}
/** A line set a word per span, as the invisible text of a scan, `gap` apart. */
function words(x: number, y: number, line: string, gap: number, height = 6.4) {
  const out: TextSpan[] = [];
  for (const word of line.split(' ')) {
    const s = span(x, y, word, height);
    out.push(s);
    x += s.bbox.width + gap;
  }
  return out;
}
const read = (spans: TextSpan[]) => layout(spans).map((b) => b.text);

describe('reading order', () => {
  it('CORE-02: a scan layer: a header across the gutter, and rivers of word gaps in a column', () => {
    // Words 9 pt apart, about the gutter's width. Three lines of the left column are set in
    // words of five letters, so their gaps line up into rivers for three lines.
    const left = [
      'Carthaginian times continued in Malta under the',
      'Romans and the temple of Juno stood on the site',
      'under Roman rule their lords would build great',
      'walls round every town they held while their sons',
      'sailed after trade until early grain grew short',
      'and the island was given to the counts of Sicily',
      'whose rule lasted until the knights of the Order',
      'came with their fleet and settled at the harbour',
    ];
    const right = [
      'In 1223 was Henry count of Malta who had led three',
      'hundred Maltese at the capture of two forts in',
      'Tripoli by the Genoese while Pope Alexander gave',
      'the crown of Sicily to Charles of Anjou against the',
      'claims of Manfred from whom the French won the',
      'kingdom at the battle of Benevento in that year',
      'and held the islands until the Sicilian Vespers',
      'when the Aragonese fleet met the French off Malta',
    ];
    const spans = [
      span(180, 10, 'MALTA AND GOZO', 11),
      ...left.flatMap((line, i) => words(20, 30 + i * 7.3, line, 9)),
      ...right.flatMap((line, i) => words(226, 30 + i * 7.3, line, 9)),
    ];
    // The columns stay apart: the widest left line ends left of the right column.
    const ends = spans.filter((s) => s.bbox.x < 200 && s.bbox.y > 20);
    expect(Math.max(...ends.map((s) => s.bbox.x + s.bbox.width))).toBeLessThan(226 - 9);
    expect(read(spans)).toEqual(['MALTA AND GOZO', left.join('\n'), right.join('\n')]);
  });

  it('CORE-02: a gutter that drifts down a scanned page still separates the columns', () => {
    // Justified lines end at 200; the right column starts at 207 and drifts to 205.5, so no
    // gutter 6 pt wide runs through every line.
    const left = Array.from(
      { length: 30 },
      (_, i) => `left column line ${i + 1} of the running text`,
    );
    const right = Array.from(
      { length: 30 },
      (_, i) => `right column line ${i + 1} of the running text`,
    );
    const spans = [
      span(80, 10, 'A RUNNING HEADER OVER BOTH', 11),
      ...left.map((text, i) => {
        const s = span(20, 30 + i * 7.3, text);
        s.bbox.width = 180;
        return s;
      }),
      ...right.map((text, i) => span(207 - (1.5 * i) / 29, 30 + i * 7.3, text)),
    ];
    expect(read(spans)).toEqual(['A RUNNING HEADER OVER BOTH', left.join('\n'), right.join('\n')]);
  });

  it('CORE-02: a gutter that drifts further than one run follows still separates the columns', () => {
    // A skewed scan: the gutter moves right by 4 pt over the page, in three steps of 2 pt.
    const steps = [0, 2, 4];
    const at = (i: number) => steps[Math.min(2, Math.floor(i / 20))];
    const left = Array.from({ length: 60 }, (_, i) => `left column line ${i + 1} of the text`);
    const right = Array.from({ length: 60 }, (_, i) => `right column line ${i + 1} of the text`);
    const spans = [
      ...left.map((text, i) => {
        const s = span(20, 30 + i * 7.3, text);
        s.bbox.width = 176 + at(i);
        return s;
      }),
      ...right.map((text, i) => span(203.5 + at(i), 30 + i * 7.3, text)),
    ];
    expect(read(spans)).toEqual([left.join('\n'), right.join('\n')]);
  });

  it('CORE-02: columns running down both sides of a figure in the middle read column by column', () => {
    // Two columns (20–190, 210–380); in rows 10–17 a figure's caption (100–290) sits between
    // narrow strips of them (20–90, 300–380).
    const line = (side: string, i: number) => `${side} column line ${i + 1} of the page`;
    const strip = (side: string, i: number) => `${side} strip ${i + 1}`;
    const spans: TextSpan[] = [];
    const left: string[] = [],
      right: string[] = [],
      caption: string[] = [];
    for (let i = 0; i < 28; i++) {
      const y = 30 + i * 7.3;
      const middle = i >= 10 && i < 18;
      const texts = middle
        ? [strip('left', i), strip('right', i)]
        : [line('left', i), line('right', i)];
      const [l, r] = texts.map((text, k) => {
        const s = span(k ? (middle ? 300 : 210) : 20, y, text);
        s.bbox.width = middle ? 70 : 170;
        return s;
      });
      spans.push(l, r);
      left.push(l.text);
      right.push(r.text);
      if (middle) {
        const c = span(100, y, `Figure caption line ${i - 9} reads here`);
        c.bbox.width = 190;
        spans.push(c);
        caption.push(c.text);
      }
    }
    expect(read(spans)).toEqual([left.join('\n'), caption.join('\n'), right.join('\n')]);
  });

  it('CORE-02: the last line of a wrapped heading stays with it, above figure labels', () => {
    const spans = [
      span(57, 300, 'remnants of dying stars, that visible-light images do not reveal.', 10),
      {
        ...span(66, 367, 'Observations from the Spitzer Space Telescope', 18),
        bbox: { x: 66, y: 367, width: 263, height: 18 },
      },
      // The heading's centred second line sits over gaps between the labels below the figure.
      { ...span(180, 385, '(SST).', 18), bbox: { x: 180, y: 385, width: 35, height: 18 } },
      span(82, 510, 'Flame nebula', 7),
      span(182, 510, 'Cassiopeia A', 7),
      span(283, 510, 'Helix nebula', 7),
    ];
    expect(read(spans)).toEqual([
      'remnants of dying stars, that visible-light images do not reveal.',
      'Observations from the Spitzer Space Telescope\n(SST).',
      'Flame nebula\tCassiopeia A\tHelix nebula',
    ]);
  });

  it('CORE-02: narrow newspaper columns with headings and bylines read column by column', () => {
    // Columns 78 pt apart with about 18 characters a line, under a line across two of them.
    const columns = [
      [
        'A question of',
        'governance',
        'A desire to be ruled',
        'by our elected',
        'members rather than',
        'faceless officials',
        'has been cited as',
        'one of the reasons',
        'GERRY RADFORD',
        'CAMBRIDGE',
      ],
      [
        'that I have noticed',
        'a lot lately in the',
        'letters sent to us',
        'ROBERT BOSTON',
        'KINGS HILL, KENT',
        'My two least liked',
        'examples of these',
        'words are from the',
        'get-go in place of',
        'the simpler start',
      ],
      [
        'forced marriages',
        'abroad is unworthy',
        'of our government',
        'and I feel that her',
        'charge of racism on',
        'the part of the office',
        'is unfounded and',
        'should be withdrawn',
        'ROBERT BAYNHAM',
        'EXMOUTH, DEVON',
      ],
    ];
    const spans = [
      span(136, 98, 'Please include a contact address with all correspondence', 5.3),
      ...columns.flatMap((lines, c) =>
        lines.map((text, i) => span(140 + c * 78, 122 + i * 7.1, text, 6)),
      ),
    ];
    expect(read(spans)).toEqual([
      'Please include a contact address with all correspondence',
      ...columns.map((lines) => lines.join('\n')),
    ]);
  });

  it('CORE-02: formulas that touch on a line are one formula', () => {
    const base = span(100, 50, '$X_{\\Sigma}$', 10),
      script = span(100 + base.bbox.width, 48, '$^{n}$', 7);
    expect(read([span(80, 50, 'Let', 10), base, script])).toEqual(['Let $X_{\\Sigma} ^{n}$']);
  });
});

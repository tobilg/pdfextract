import { describe, expect, it } from 'vitest';
import type { Page, PageGlyphs } from '../../packages/core/src/engine.js';
import { layout } from '../../packages/core/src/geometry.js';
import {
  composeAccents,
  letterSpaced,
  nativeSpans,
  respace,
} from '../../packages/core/src/text.js';

// A page whose text content is given directly: a body line and a margin stamp rotated a
// quarter turn, as arXiv prints it, in a font PDF.js reports NaN metrics for.
const page = {
  userUnit: 1,
  getTextContent: async () => ({
    items: [
      { str: 'Body text', width: 45, transform: [10, 0, 0, 10, 100, 700], fontName: 'body' },
      {
        str: 'arXiv:2503.03762v1',
        width: 180,
        transform: [0, 20, -20, 0, 32, 252],
        fontName: 'stamp',
      },
    ],
    styles: {
      body: { fontFamily: 'sans-serif', ascent: 0.75, descent: -0.25 },
      stamp: { fontFamily: 'serif', ascent: Number.NaN, descent: Number.NaN },
    },
  }),
} as unknown as Page;
const viewport = { transform: [1, 0, 0, -1, 0, 792] };

describe('nativeSpans', () => {
  it('TEXT-01: fonts with NaN metrics get finite boxes, and layout reads the page', async () => {
    const spans = await nativeSpans(page, viewport);
    for (const span of spans) {
      expect(Object.values(span.bbox).every(Number.isFinite)).toBe(true);
      expect(span.quad?.every(Number.isFinite)).toBe(true);
    }
    // The stamp runs up the left margin: 180 pt tall, a line (20 pt × typical metrics) wide.
    expect(spans[1].bbox).toEqual({ x: 16, y: 360, width: 20, height: 180 });
    const text = layout(spans).map((b) => b.text);
    expect(text).toContain('Body text');
    expect(text).toContain('arXiv:2503.03762v1');
  });
});

/** A page of the given text items, in a font with typical metrics. */
const pageOf = (items: object[]) =>
  ({
    userUnit: 1,
    getTextContent: async () => ({
      items: items.map((item) => ({ fontName: 'f', hasEOL: false, ...item })),
      styles: { f: { fontFamily: 'serif', ascent: 0.8, descent: -0.2 } },
    }),
  }) as unknown as Page;
const read = async (items: object[]) =>
  layout(await nativeSpans(pageOf(items), viewport)).map((b) => b.text);

describe('nativeSpans: widths and word breaks', () => {
  it('TEXT-02: text scaled across its baseline unlike along it keeps its measured width', async () => {
    // A Type 3 font whose matrix scales x by 0.12 and y by 13: words 28 pt wide, not 0.3 pt.
    const spans = await nativeSpans(
      pageOf([
        { str: 'Experiments', width: 70, transform: [0.12, 0, 0, 13, 88, 700] },
        { str: 'with', width: 25, transform: [0.12, 0, 0, 13, 162, 700] },
      ]),
      viewport,
    );
    expect(spans.map((s) => s.bbox.width)).toEqual([70, 25]);
    expect(layout(spans).map((b) => b.text)).toEqual(['Experiments with']);
  });

  it('TEXT-03: a space of its own breaks words, if it fits the gap between them', async () => {
    // A scan's text layer: each word fitted to its image, a narrow space glyph between.
    expect(
      await read([
        { str: 'The method of', width: 60.5, transform: [5.4, 0, 0, 12.3, 321.1, 700] },
        { str: ' ', width: 0.06, transform: [6.8, 0, 0, 12.3, 381.6, 700] },
        { str: 'making', width: 26.9, transform: [7.5, 0, 0, 12.3, 382.3, 700] },
      ]),
    ).toEqual(['The method of making']);
    // Spaces wider than the gap (a Type 3 font's kerning) or empty (small capitals changing
    // size) break nothing.
    expect(
      await read([
        { str: 'Exp', width: 28.1, transform: [10, 0, 0, 10, 88.1, 700] },
        { str: ' ', width: 4, transform: [10, 0, 0, 10, 116.2, 700] },
        { str: 'eriments', width: 60, transform: [10, 0, 0, 10, 116.6, 700] },
        { str: ' ', width: 2.5, transform: [10, 0, 0, 10, 176.6, 700] },
        { str: 'D', width: 7.25, transform: [10, 0, 0, 10, 179.1, 700] },
        { str: ' ', width: 0, transform: [10, 0, 0, 10, 186.35, 700] },
        { str: 'IRECT', width: 23, transform: [8, 0, 0, 8, 186.36, 700] },
      ]),
    ).toEqual(['Experiments DIRECT']);
  });
});

describe('composeAccents', () => {
  it('TEXT-04: accents drawn apart from their letters join them, before or after', async () => {
    const spans = await nativeSpans(
      pageOf([
        // TeX: the accent ends a run, its letter begins the next, drawn back over it.
        { str: 'study of Gr¨', width: 54, transform: [10, 0, 0, 10, 100, 700] },
        { str: 'obner bases', width: 52, transform: [10, 0, 0, 10, 151, 700], hasEOL: true },
        // Others: the accent after its letter, alone or starting the next run.
        { str: 'the Guapore', width: 54, transform: [10, 0, 0, 10, 100, 680] },
        { str: '´', width: 3, transform: [10, 0, 0, 10, 150, 680], hasEOL: true },
        { str: 'and Sa', width: 30, transform: [10, 0, 0, 10, 100, 660] },
        { str: '˜o Francisco', width: 56, transform: [10, 0, 0, 10, 126, 660], hasEOL: true },
        // Not over a letter: a tilde in a path stays.
        { str: 'www.sfu.ca/˜ssurjano', width: 95, transform: [10, 0, 0, 10, 100, 640] },
      ]),
      viewport,
    );
    composeAccents(spans);
    expect(layout(spans).map((b) => b.text)).toEqual([
      'study of Gröbner bases',
      'the Guaporé',
      'and São Francisco',
      'www.sfu.ca/˜ssurjano',
    ]);
  });
});

describe('respace', () => {
  it('TEXT-05: letter-spaced runs read as words from their glyphs', () => {
    // Glyphs 6 pt wide in PDF space (y up), letters 2 pt apart, words 6 pt apart.
    const glyphs: PageGlyphs['glyphs'] = [];
    const set = (text: string, x: number, y: number, letter: number, word: number) => {
      for (const char of text) {
        if (char === ' ') x += word - letter;
        else {
          glyphs.push({ text: char, code: 0, font: 'f', x0: x, x1: x + 6, y, size: 10 });
          x += 6 + letter;
        }
      }
    };
    set('ARTICLE INFO', 100, 692, 2, 6);
    // Single letters each a word: initials, spaced as words are.
    set('A G D Maran', 100, 672, 0.5, 3);
    const spans = [
      { text: 'A R T I C L E I N F O', y: 100 },
      { text: 'A G D M a r a n', y: 120 },
      { text: 'ordinary text', y: 140 },
    ].map(({ text, y }) => ({
      text,
      bbox: { x: 100, y, width: 120, height: 10 },
      source: 'native' as const,
    }));
    expect(letterSpaced(spans)).toBe(true);
    respace(spans, { glyphs, fonts: {}, rules: [] }, viewport);
    expect(spans.map((s) => s.text)).toEqual(['ARTICLE INFO', 'A G D Maran', 'ordinary text']);
  });
});

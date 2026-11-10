import type { Quad, TextSpan } from './contracts.js';
import type { Page, PageFonts, PageGlyphs } from './engine.js';
import { multiply, transformBox, wordBreaks } from './geometry.js';

/**
 * Native text spans of a page in canonical page points, from the PDF's text layer. With the
 * page's fonts, spans report the PDF font name and spans set in a bold face are added to `bold`.
 */
export async function nativeSpans(
  page: Page,
  viewport: { transform: number[] },
  fonts: PageFonts = {},
  bold?: WeakSet<TextSpan>,
): Promise<TextSpan[]> {
  const content = await page.getTextContent();
  const spans: TextSpan[] = [];
  // A space of its own between two runs of a line is a word break, however narrow: text layers
  // of scans write each word apart, fitted to its image, with a space glyph between. It has to
  // fit between them, in a visible gap: PDF.js also reports spaces where a Type 3 font's metrics
  // mislead it, and empty ones where small capitals change size.
  let last: TextSpan | undefined, space: number | undefined;
  for (const item of content.items) {
    if (!item.str) {
      if (item.hasEOL) last = undefined;
      continue;
    }
    // Text may be scaled differently along and across its baseline (horizontal scaling, Type 3
    // font matrices): the width PDF.js measures runs along the baseline, in page units.
    const across = Math.hypot(item.transform[2], item.transform[3]),
      along = Math.hypot(item.transform[0], item.transform[1]);
    const size = across || along || 1;
    // PDF.js reports NaN metrics for some fonts (seen on arXiv's rotated margin stamp); fall back
    // to typical ones so boxes stay finite.
    const style = content.styles[item.fontName] ?? {},
      metrics = Number.isFinite(style.ascent) && Number.isFinite(style.descent),
      ascent = metrics && style.ascent > style.descent ? style.ascent : 0.8,
      descent = metrics && style.ascent > style.descent ? style.descent : -0.2,
      width = item.width / (along || size),
      m = multiply(viewport.transform, item.transform),
      font = fonts[item.fontName];
    const span: TextSpan = {
      text: item.str,
      bbox: transformBox({ x: 0, y: descent, width, height: ascent - descent }, m),
      quad: corners(m, width, ascent, descent),
      source: 'native',
      fontName: font?.name || (style.fontFamily ?? item.fontName),
      fontSize: size * page.userUnit,
    };
    spans.push(span);
    if (font?.bold) bold?.add(span);
    if (!item.str.trim()) space = item.width;
    else {
      if (space !== undefined && last) {
        const gap = span.bbox.x - last.bbox.x - last.bbox.width;
        if (gap >= Math.max(space * 0.9, span.bbox.height * 0.04)) wordBreaks.set(last, span);
      }
      space = undefined;
      last = span;
    }
    if (item.hasEOL) last = undefined;
  }
  return spans;
}
/** The span's corners (top-left, top-right, bottom-right, bottom-left) mapped by m. */
function corners(m: readonly number[], width: number, ascent: number, descent: number): Quad {
  const map = (x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  return [
    ...map(0, ascent),
    ...map(width, ascent),
    ...map(width, descent),
    ...map(0, descent),
  ] as unknown as Quad;
}
/** Spacing accents a text layer may draw apart from their letter, and the marks they stand for. */
const MARKS: Record<string, string> = {
  '`': '̀',
  '´': '́',
  ˆ: '̂',
  '˜': '̃',
  '¯': '̄',
  '˘': '̆',
  '˙': '̇',
  '¨': '̈',
  '˚': '̊',
  '˝': '̋',
  ˇ: '̌',
  '¸': '̧',
  '˛': '̨',
};
/** A letter with an accent: dotless i and j take it as i and j do. */
const accented = (letter: string, accent: string) =>
  `${letter === 'ı' ? 'i' : letter === 'ȷ' ? 'j' : letter}${MARKS[accent]}`.normalize('NFC');
/**
 * Accents set over their letter as glyphs of their own (TeX's \'o, older typesetting) join it:
 * Gr¨obner reads Gröbner. The accent and its letter overlap, so the run after the accent's starts
 * left of where that one ends. TeX draws an accent before its letter, which then begins the next
 * run; other typesetters draw it after, at the start of the next run or as one of its own.
 * Spans are in drawing order; their text changes in place.
 */
export function composeAccents(spans: readonly TextSpan[]) {
  for (let i = 1; i < spans.length; i++) {
    const previous = spans[i - 1],
      span = spans[i];
    const end = previous.bbox.x + previous.bbox.width;
    if (
      span.bbox.x >= end - 0.1 ||
      Math.abs(span.bbox.y - previous.bbox.y) >
        0.4 * Math.min(span.bbox.height, previous.bbox.height)
    )
      continue;
    const before = previous.text.at(-1) ?? '',
      after = span.text[0] ?? '';
    // (ˆ and ˇ are modifier letters.)
    const letter = (c: string) => /\p{L}/u.test(c) && !MARKS[c];
    if (MARKS[before] && letter(after)) {
      previous.text = previous.text.slice(0, -1);
      span.text = accented(after, before) + span.text.slice(1);
    } else if (MARKS[after] && letter(before) && span.bbox.x >= previous.bbox.x) {
      previous.text = previous.text.slice(0, -1) + accented(before, after);
      span.text = span.text.slice(1);
    }
  }
}
/** Four letters or more set apart one by one, as PDF.js reads letter-spaced type: R E S E A R C H. */
const SPACED = /(?:^|\s)\p{L}(?: \p{L}){3,}(?=$|[\s.,;:!?)])/u;
/** Whether a page has runs that {@link respace} would read again. */
export const letterSpaced = (spans: readonly TextSpan[]) => spans.some((s) => SPACED.test(s.text));
/**
 * Letter-spaced runs read again from their glyphs: PDF.js puts a space between letters set
 * wider apart than a space's worth, and only one between words. Letters a run's usual letter
 * gap apart join; gaps wider by 0.15 em or more part words. A run whose glyphs do not match
 * its text stays as it is. Text changes in place.
 */
export function respace(
  spans: readonly TextSpan[],
  page: PageGlyphs,
  viewport: { transform: number[] },
) {
  const [a, b, c, d, e, f] = viewport.transform;
  if (b || c) return;
  const glyphs = page.glyphs.map((g) => ({
    text: g.text,
    x0: a * g.x0 + e,
    x1: a * g.x1 + e,
    base: d * g.y + f,
    size: g.size * Math.abs(d),
  }));
  for (const span of spans) {
    if (!SPACED.test(span.text)) continue;
    const { x, y, width, height } = span.bbox;
    const own = glyphs
      .filter(
        (g) =>
          (g.x0 + g.x1) / 2 >= x - 0.5 &&
          (g.x0 + g.x1) / 2 <= x + width + 0.5 &&
          g.base >= y - 0.5 &&
          g.base <= y + height + 0.5,
      )
      .sort((p, q) => p.x0 - q.x0);
    // The span's characters, each matched to its glyph; spaces between them noted.
    const chars = [...span.text.trim()];
    const letters: { glyph: (typeof own)[number]; spaced: boolean }[] = [];
    let k = 0,
      spaced = false;
    for (const char of chars) {
      if (/\s/.test(char)) {
        spaced = true;
        continue;
      }
      const glyph = own[k];
      if (!glyph || glyph.text.normalize('NFKC') !== char.normalize('NFKC')) {
        letters.length = 0;
        break;
      }
      letters.push({ glyph, spaced });
      spaced = false;
      k++;
    }
    if (!letters.length || k !== own.length) continue;
    // Gaps between letters the text spaces apart, single letters on both sides: the run's
    // letter gap is the smallest of them.
    const single = (i: number) =>
      (i === 0 || letters[i].spaced) && (i === letters.length - 1 || letters[i + 1].spaced);
    const gap = (i: number) => letters[i].glyph.x0 - letters[i - 1].glyph.x1;
    const tracked = letters.flatMap((_, i) =>
      i > 0 && letters[i].spaced && (single(i) || single(i - 1)) ? [gap(i)] : [],
    );
    if (!tracked.length) continue;
    const letter = Math.min(...tracked);
    let text = letters[0].glyph.text;
    for (let i = 1; i < letters.length; i++) {
      const word = letters[i].spaced && gap(i) > letter + 0.15 * letters[i].glyph.size;
      const keep = letters[i].spaced && !single(i) && !single(i - 1);
      text += (word || keep ? ' ' : '') + letters[i].glyph.text;
    }
    span.text = text;
  }
}

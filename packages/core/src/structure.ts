import type { TextBlock, TextLine, TextSpan } from './contracts.js';
import { union } from './geometry.js';

/** Page facts heading detection needs beyond the blocks themselves. */
export interface HeadingContext {
  /** Canonical page height in points, to recognize running headers and footers. */
  height: number;
  /** Whether a native span is set in a bold face. */
  bold: (span: TextSpan) => boolean;
}

const letters = (text: string) => text.match(/\p{L}/gu)?.length ?? 0;
/** Dot or underscore leaders of a table of contents or form. */
const LEADER = /\.{4,}|(?:\. ){3,}|…{2,}|_{4,}/;
/** Captions and notes: numbered labels ("Table 13.2.", "Figure 3:") and figure/source lines. */
export const CAPTION =
  /^((fig(ure)?|table|tab|exhibit|chart|graph|plate|photo|image|map|diagram)\.?\s*\d|(fig(ure)?|source|sources|note|notes|photo|image)\b)/i;
/** A date alone, as on title pages and in running headers. */
const DATE =
  /^((\d{1,2}\.?\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(\s+\d{1,2},?)?\s+\d{4}|\d{4}([-/.]\d{1,2}){2})$/i;
/** Section names that are headings by convention, even set like body text. */
const SECTION =
  /^((\d+(\.\d+)*\.?|[IVX]+\.)\s+)?(table of contents|contents|abstract|introduction|background|conclusions?|summary|executive summary|references|bibliography|acknowledge?ments|appendix(\s+[A-Z0-9]+)?|appendices|glossary|preface|foreword|limitations)$/i;

/**
 * Marks short lines set larger than the page's body text, or bold where body text is not, as
 * headings (`headingLevel`), splitting them out of their paragraph blocks. Levels rank the
 * heading sizes on the page. Native type size and weight decide; on pages read entirely by OCR, word box heights do.
 * Lines of running headers/footers, tables, captions, leaders and numbers are never headings.
 */
/** A line going on with a sentence: a lowercase word, not an item's letter (l. Replace). */
const CONTINUATION = /^(\p{Ll}{2}|\p{Ll}\s)/u;
export function markHeadings(blocks: TextBlock[], context: HeadingContext): TextBlock[] {
  // Body type is measured over all text, tables included (a page may be mostly table); only
  // lines outside tables can be headings.
  const spans = blocks.flatMap((b) => b.lines.flatMap((l) => l.spans));
  const native = spans.filter((s) => s.source === 'native' && s.fontSize);
  const chars = (list: TextSpan[]) => list.reduce((n, s) => n + s.text.trim().length, 0);
  // A page read (almost) entirely by OCR, such as a scan or outlined lettering with a stray label.
  const ocrOnly = chars(native) < chars(spans) * 0.2;
  // Size of a line: character-weighted type size, or its box height when read by OCR.
  const sizeOf = (line: TextLine) => {
    if (ocrOnly) return line.spans.every((s) => s.source === 'ocr') ? line.bbox.height : 0;
    const sized = line.spans.filter((s) => s.source === 'native' && s.fontSize);
    const chars = sized.reduce((n, s) => n + s.text.trim().length, 0);
    return chars
      ? sized.reduce((n, s) => n + (s.fontSize ?? 0) * s.text.trim().length, 0) / chars
      : 0;
  };
  // Body text: the size (to 0.5pt) and weight carrying the most characters.
  const weight = new Map<number, number>();
  let boldChars = 0,
    allChars = 0;
  for (const line of blocks.flatMap((b) => b.lines)) {
    const chars = line.text.replace(/\s/g, '').length,
      size = Math.round(sizeOf(line) * 2) / 2;
    if (size) weight.set(size, (weight.get(size) ?? 0) + chars);
  }
  for (const span of native) {
    const chars = span.text.trim().length;
    allChars += chars;
    if (context.bold(span)) boldChars += chars;
  }
  const body = [...weight].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!body) return blocks;
  const bodyBold = boldChars > allChars * 0.5,
    minRatio = ocrOnly ? 1.3 : 1.15;

  const heading = (line: TextLine) => {
    const text = line.text.trim();
    if (text.length > 150 || letters(text) < 3) return false;
    if (letters(text) < text.replace(/\s/g, '').length * 0.5) return false;
    // Nor does one end within a sentence or a word broken at the line end.
    if (
      LEADER.test(text) ||
      CAPTION.test(text) ||
      DATE.test(text) ||
      /[,;]$/.test(text) ||
      /\p{L}[-\u00ad\u2010]$/u.test(text)
    )
      return false;
    // A heading is one run of text: not cells apart (a table row, a contents entry with its
    // page number), and not a reference.
    if (/\t/.test(line.text) || /https?:\/\/|www\./i.test(text)) return false;
    const ratio = sizeOf(line) / body;
    if (!ratio) return false;
    const bold = !ocrOnly && line.spans.every((s) => s.source === 'native' && context.bold(s));
    // Running headers and footers sit at the page edges in body-like type.
    const edge =
      line.bbox.y < context.height * 0.06 || line.bbox.y + line.bbox.height > context.height * 0.94;
    if (edge && ratio < 1.3) return false;
    if (/\.$/.test(text) && ratio < 1.3) return false;
    return ratio >= minRatio || (bold && !bodyBold && ratio >= 0.95);
  };

  const out: TextBlock[] = [];
  const sizes: number[] = [];
  const push = (group: TextLine[], isHeading: boolean) => {
    if (!group.length) return;
    const block: TextBlock = {
      text: group.map((l) => l.text).join('\n'),
      bbox: union(group.map((l) => l.bbox)),
      lines: group,
    };
    if (isHeading) {
      // Ranked once all heading sizes on the page are known.
      block.headingLevel = 0;
      sizes.push(sizeOf(group[0]));
    }
    out.push(block);
  };
  for (const block of blocks) {
    if (block.tableIndex !== undefined) {
      out.push(block);
      continue;
    }
    // A line that only names a conventional section ("Contents", "References") and opens its
    // block is a heading even when set like body text.
    const section = (line: TextLine, i: number) =>
      i === 0 && SECTION.test(line.text.trim()) && sizeOf(line) >= body * 0.9;
    const flags = block.lines.map((line, i) => heading(line) || section(line, i));
    // A run of more than three heading-like lines is a passage set in large or bold type.
    for (let i = 0; i < flags.length; ) {
      let j = i;
      while (j < flags.length && flags[j] === flags[i]) j++;
      if (flags[i] && j - i > 3) for (let k = i; k < j; k++) flags[k] = false;
      i = j;
    }
    // Lines of one sentence (a lowercase word after no full stop) where one of them reads as body
    // text: a line in large type within a paragraph, not a heading. (A heading's own lines
    // may go on so: both read as headings.)
    const sentence = (i: number) =>
      CONTINUATION.test(block.lines[i].text.trim()) &&
      !/[.!?:]["'”’)]*$/.test(block.lines[i - 1].text.trim());
    const first = [...flags];
    for (let i = 0; i < flags.length; i++)
      if (
        first[i] &&
        ((i > 0 && !first[i - 1] && sentence(i)) ||
          (i + 1 < flags.length && !first[i + 1] && sentence(i + 1)))
      )
        flags[i] = false;
    let group: TextLine[] = [],
      current = flags[0];
    block.lines.forEach((line, i) => {
      // Consecutive heading lines join while they share a size; a size change starts a new one.
      const sameHeading =
        flags[i] && current && group.length && Math.abs(sizeOf(line) - sizeOf(group[0])) < 0.5;
      if (flags[i] !== current || (flags[i] && !sameHeading && group.length)) {
        push(group, current);
        group = [];
        current = flags[i];
      }
      group.push(line);
    });
    push(group, current);
  }
  // Levels: distinct heading sizes on the page, largest first.
  const ranks = [...new Set(sizes.map((s) => Math.round(s * 2) / 2))].sort((a, b) => b - a);
  for (const block of out)
    if (block.headingLevel !== undefined)
      block.headingLevel = Math.min(
        6,
        ranks.indexOf(Math.round(sizeOf(block.lines[0]) * 2) / 2) + 1,
      );
  return out;
}

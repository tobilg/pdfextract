import type { TextBlock, TextPage, TextSpan } from './contracts.js';
import { CAPTION } from './structure.js';

/**
 * Page furniture: running headers and footers (journal lines, running titles, page numbers,
 * copyright and download notices) at the top and bottom edges of a page, and stamps set at a
 * quarter turn along its side edges.
 *
 * On one page, a band of blocks counts when it lies in the top or bottom 15% of the page, is
 * short (at most four lines, not a table, a heading, prose unless it holds a copyright notice,
 * a paragraph continued from the previous page or a footnote) and is set apart from the text
 * toward the middle by a gap: at least half a line height for type up to 1.3 times the body
 * size, 1.5 for a single larger line (a journal name). Prose is three long lines, or two of
 * lowercase words. Bands are taken from the edge inward until one does not qualify. Page
 * numbers in the zone always count. A full-width line counts when it cites the publication
 * (volume, DOI, a copyright, download or citation notice), and a lowercase start does not mean
 * a continued paragraph in short lines ending no sentence (a running title set in lowercase, a
 * web address, a date over two lines). Text at a quarter turn in the outer tenth of the width
 * is a `margin` stamp. Across pages, a short block near an edge whose text (digits aside)
 * recurs at the same height on other pages counts too.
 */

const ZONE = 0.15;
/** Reach of the cross-page check: repeated text may sit further in. */
const REPEAT_ZONE = 0.2;
const PAGE_NUMBER =
  /^\W*((page|p\.?|seite|p[aá]g(ina)?\.?)\s*)?(\d{1,4}|[ivxlcdm]{1,7})(\s*(of|de|von|\/)\s*\d{1,4})?(\s*\|\s*(page|seite|p[aá]gina))?\W*$/i;
/**
 * Lines that cite the publication rather than continue the text: journal volume and issue,
 * DOI, ISSN, a copyright, download or citation notice, a court filing's case line.
 */
const CITATION =
  /\b(vol\.?\s*\d|volume\s+\d|no\.\s*\d|issue\s+\d|pp\.\s*\d|doi\b|issn\b|isbn\b|all rights reserved|copyright|please cite|cite this|published (on|by|online)|downloaded from|available (at|online)|journal homepage|case \d+:\d+-|page \d+ of \d+)|©/i;

/** A copyright or licence notice: the lines around it are the publication's, not prose. */
const COPYRIGHT = /©|\bcopyright\b|all rights reserved/i;
/** A footnote: a number or reference mark, then text. */
const FOOTNOTE = /^(\d{1,3}|[*†‡§])[.)]?\s*\p{L}/u;
/** An equation number set at the margin: (3), (15.19), (2a). */
const EQUATION = /^\(\d+(\.\d+)*[a-z]?\)$/;

type Side = 'header' | 'footer';
/** Rows of blocks that overlap vertically, top to bottom. */
function bands(blocks: TextBlock[], tolerance: number) {
  const out: { top: number; bottom: number; blocks: TextBlock[] }[] = [];
  for (const block of [...blocks].sort((a, b) => a.bbox.y - b.bbox.y)) {
    const top = block.bbox.y,
      bottom = top + block.bbox.height;
    const band = out.find((b) => top < b.bottom - tolerance && bottom > b.top + tolerance);
    if (band) {
      band.blocks.push(block);
      band.top = Math.min(band.top, top);
      band.bottom = Math.max(band.bottom, bottom);
    } else out.push({ top, bottom, blocks: [block] });
  }
  return out;
}
/** Largest native type size of a block, relative to the page's body size (1 when unknown). */
function sizes(blocks: TextBlock[]) {
  const weight = new Map<number, number>();
  for (const span of blocks.flatMap((b) => b.lines.flatMap((l) => l.spans)))
    if (span.fontSize) {
      const size = Math.round(span.fontSize * 2) / 2;
      weight.set(size, (weight.get(size) ?? 0) + span.text.trim().length);
    }
  const body = [...weight].sort((a, b) => b[1] - a[1])[0]?.[0];
  return (block: TextBlock) => {
    const size = Math.max(0, ...block.lines.flatMap((l) => l.spans.map((s) => s.fontSize ?? 0)));
    return body && size ? size / body : 1;
  };
}

/** Marks the furniture of one page by position (see the module comment). */
export function markFurniture(page: TextPage) {
  const ratio = sizes(page.blocks),
    found = bands(page.blocks, page.height * 0.002);
  const qualifies = (block: TextBlock, gap: number, side: Side) => {
    const text = block.text.trim();
    if (PAGE_NUMBER.test(text)) return true;
    if (block.tableIndex !== undefined || block.headingLevel || block.lines.length > 4)
      return false;
    // Body text near an edge: lines of prose, a paragraph continued from the previous page
    // (lowercase start), a full-width line of running text, a footnote.
    // Prose: lines of running text, measured by their longest tab-separated part (a header's
    // left and right parts, joined by a tab, are not one long line).
    const parts = block.lines.map((l) =>
      Math.max(...l.text.split('\t').map((p) => p.trim().length)),
    );
    const long = parts.reduce((n, p) => n + p, 0) / parts.length >= 50;
    if (parts.length >= 3 && long && !COPYRIGHT.test(text)) return false;
    // Two long lines of lowercase words: a paragraph (Here B denotes … readily deduced / from
    // parabolic estimates:), not a running header; one giving a web address is a notice.
    const tokens = text.split(/\s+/).filter((w) => /\p{L}{2}/u.test(w));
    if (
      parts.length === 2 &&
      long &&
      tokens.filter((w) => /^\P{L}*\p{Ll}/u.test(w)).length >= tokens.length * 0.6 &&
      !CITATION.test(text) &&
      !/https?:\/\/|www\./i.test(text)
    )
      return false;
    if (CAPTION.test(text) || EQUATION.test(text)) return false;
    // A lowercase start continues a paragraph, unless the block is short lines that end no
    // sentence (a running title set in lowercase, a page word, a web address, a date set over
    // two lines: week ending / 17 MARCH 2006) or cites the publication.
    if (
      /^\p{Ll}/u.test(text) &&
      !/^(www|http|doi|e-?mail)/i.test(text) &&
      ((block.lines.length > 1 && Math.max(...parts) >= 30) ||
        text.length >= 40 ||
        /[.!?;:,]$/.test(text)) &&
      !CITATION.test(text)
    )
      return false;
    if (
      block.lines.length === 1 &&
      !block.text.includes('\t') &&
      text.length >= 50 &&
      !CITATION.test(text)
    )
      if (block.bbox.width >= page.width * 0.6) return false;
    if (side === 'footer' && FOOTNOTE.test(text) && (block.lines.length >= 2 || text.length >= 80))
      return false;
    const lineHeight = Math.max(block.lines[0]?.bbox.height ?? 0, 6),
      r = ratio(block);
    // A sentence at the body size (a short paragraph opening or closing the page: five words
    // or more, mostly lowercase, a full stop at the end) is text, unless it cites the
    // publication. Names, titles and leaders are no sentences.
    const words = text.split(/\s+/).filter((w) => /\p{L}{2}/u.test(w));
    if (
      r >= 0.95 &&
      words.length >= 5 &&
      words.filter((w) => /^\P{L}*\p{Ll}/u.test(w)).length >= words.length * 0.5 &&
      /[^.][.!?]$/.test(text) &&
      !CITATION.test(text)
    )
      return false;
    if (r <= 1.3) return gap >= 0.5 * lineHeight;
    return r <= 2 && block.lines.length === 1 && gap >= 1.5 * lineHeight;
  };
  // Bands from the edge inward. Stacked header lines (a report number above a page number)
  // count as a group: the gap that matters is the one between the group and the text.
  const walk = (order: typeof found, side: Side) => {
    let last = -1;
    for (const [i, band] of order.entries()) {
      const inZone =
        side === 'header'
          ? band.bottom <= page.height * ZONE
          : band.top >= page.height * (1 - ZONE);
      if (!inZone) break;
      const next = order[i + 1],
        gap = !next
          ? Number.POSITIVE_INFINITY
          : side === 'header'
            ? next.top - band.bottom
            : band.top - next.bottom;
      const group = order.slice(0, i + 1).flatMap((b) => b.blocks);
      if (group.every((b) => qualifies(b, gap, side))) last = i;
    }
    for (const band of order.slice(0, last + 1))
      for (const block of band.blocks) block.furniture = side;
  };
  walk(found, 'header');
  walk([...found].reverse(), 'footer');
  // Stamps along a side edge: text at a quarter turn in the outer tenth of the width.
  for (const block of page.blocks) {
    const spans = block.lines.flatMap((l) => l.spans);
    if (block.furniture || !spans.length || !spans.every(turned)) continue;
    const { x, width } = block.bbox;
    if (x + width <= page.width * MARGIN || x >= page.width * (1 - MARGIN))
      block.furniture = 'margin';
  }
}
/** Outer share of the width where text set at a quarter turn is a margin stamp. */
const MARGIN = 0.1;
/** Text set at a quarter turn: its baseline runs up or down the page. */
function turned(span: TextSpan) {
  const q = span.quad;
  return !!q && Math.abs(q[2] - q[0]) < Math.abs(q[3] - q[1]);
}

/**
 * Marks blocks near a page edge whose text, digits aside, recurs at the same height on other
 * pages: running heads and page numbers that the single-page check missed.
 */
export function markRepeatedFurniture(pages: TextPage[]) {
  if (pages.length < 2) return;
  const needed = Math.min(3, pages.length);
  const signature = (block: TextBlock) =>
    block.text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  const candidates = pages.flatMap((page) =>
    page.blocks
      .filter(
        (b) =>
          !b.furniture &&
          b.tableIndex === undefined &&
          b.lines.length <= 2 &&
          b.text.trim().length <= 150 &&
          (b.bbox.y + b.bbox.height <= page.height * REPEAT_ZONE ||
            b.bbox.y >= page.height * (1 - REPEAT_ZONE)),
      )
      .map((block) => ({
        block,
        page: page.pageNumber,
        key: signature(block),
        y: (block.bbox.y + block.bbox.height / 2) / page.height,
      })),
  );
  for (const c of candidates) {
    if (!c.key) continue;
    const pagesWith = new Set(
      candidates.filter((o) => o.key === c.key && Math.abs(o.y - c.y) <= 0.02).map((o) => o.page),
    );
    if (pagesWith.size >= needed) c.block.furniture = c.y < 0.5 ? 'header' : 'footer';
  }
}

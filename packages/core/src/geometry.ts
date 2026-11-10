import type {
  AffineTransform,
  Box,
  ImageOrientation,
  TextBlock,
  TextLine,
  TextSpan,
} from './contracts.js';
import type { DetectedTable } from './tables.js';
export function multiply(m: readonly number[], n: readonly number[]): AffineTransform {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
/** Whether two boxes share more than a hairline area. */
export function intersects(a: Box, b: Box) {
  return (
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0.01 &&
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0.01
  );
}
export function point(m: readonly number[], x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}
export function transformBox(b: Box, m: readonly number[]): Box {
  const points = [
    [b.x, b.y],
    [b.x + b.width, b.y],
    [b.x + b.width, b.y + b.height],
    [b.x, b.y + b.height],
  ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1]);
  const x = Math.min(...xs),
    y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
export function union(boxes: Box[]): Box {
  if (!boxes.length) return { x: 0, y: 0, width: 0, height: 0 };
  const x = Math.min(...boxes.map((b) => b.x)),
    y = Math.min(...boxes.map((b) => b.y));
  return {
    x,
    y,
    width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
    height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
  };
}
export function overlap(a: Box, b: Box) {
  const area =
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return area / Math.max(1, Math.min(a.width * a.height, b.width * b.height));
}
const normalized = (s: string) =>
  s
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
/** 1 for equal strings, 0 for entirely different ones (normalized Levenshtein distance). */
function similarity(a: string, b: string) {
  if (a === b) return 1;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length, 1);
}
/**
 * Whether an OCR word repeats native text it overlaps: the same normalized word(s), or a close
 * misreading of them ("skills.5!" for "skills.51"), since native text is authoritative.
 */
export function duplicate(ocr: TextSpan, native: readonly TextSpan[]) {
  const words = normalized(ocr.text);
  if (!words) return false;
  const count = words.split(' ').length;
  return native.some((n) => {
    if (overlap(ocr.bbox, n.bbox) <= 0.45) return false;
    const tokens = normalized(n.text).split(' ');
    if (` ${tokens.join(' ')} `.includes(` ${words} `)) return true;
    if (words.length < 4) return false;
    for (let i = 0; i + count <= tokens.length; i++)
      if (similarity(tokens.slice(i, i + count).join(' '), words) >= 0.75) return true;
    return false;
  });
}
/** Spans on one baseline: the row grouping shared by line building and table detection. */
const widest = (row: TextSpan[]) =>
  row.reduce((best, s) => (s.bbox.width > best.bbox.width ? s : best));
function sameRow(a: Box, b: Box) {
  return Math.abs(a.y - b.y) <= Math.max(2, Math.min(a.height, b.height) * 0.4);
}
/**
 * Returns a shared key for spans that a provider already recognized as one line (OCR words),
 * or undefined for spans whose lines core must form itself (native text runs).
 */
export type LineKey = (span: TextSpan) => object | undefined;
/**
 * Smallest unit of the reading-order cut: one native run, or one provider line (a piece of it
 * when the line crosses a gutter-sized gap). `line` identifies the provider line.
 */
interface Atom {
  spans: TextSpan[];
  bbox: Box;
  chars: number;
  line?: object;
  /** A detected table, already laid out, that reading order places as one unit. */
  block?: TextBlock;
}
type Interval = [start: number, end: number];

const byPosition = (a: { bbox: Box }, b: { bbox: Box }) =>
  a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x;
function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}
/** Merged horizontal extents covered by the atoms; the spaces between them are candidate gutters. */
function coverage(intervals: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const [start, end] of [...intervals].sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}
const extents = (atoms: readonly Atom[]): Interval[] =>
  atoms.map((a) => [a.bbox.x, a.bbox.x + a.bbox.width]);
function gutters(covered: Interval[], min: number) {
  const out: { start: number; width: number }[] = [];
  for (let i = 1; i < covered.length; i++) {
    const width = covered[i][0] - covered[i - 1][1];
    if (width >= min) out.push({ start: covered[i - 1][1], width });
  }
  return out;
}
/** Groups atoms into horizontal strips separated by vertical whitespace, top to bottom. */
function strips(atoms: readonly Atom[]): Atom[][] {
  const out: Atom[][] = [];
  let bottom = Number.NEGATIVE_INFINITY;
  for (const atom of [...atoms].sort(byPosition)) {
    // Boxes of adjacent lines may touch or overlap slightly; that still separates them.
    if (!out.length || atom.bbox.y >= bottom - atom.bbox.height * 0.15) out.push([atom]);
    else out[out.length - 1].push(atom);
    bottom = Math.max(bottom, atom.bbox.y + atom.bbox.height);
  }
  return out;
}
const charsPerRow = (atoms: readonly Atom[]) =>
  atoms.reduce((n, a) => n + a.chars, 0) / strips(atoms).length;
/**
 * Prose-like side of a column cut: several rows of running text rather than short table cells.
 * Narrow columns (newspapers, three-column magazines) set about 20 characters a line, and their
 * headings and short last lines bring the average lower: rows of words do there.
 */
function prose(atoms: readonly Atom[]) {
  const rows = strips(atoms).length,
    perRow = charsPerRow(atoms);
  if (rows < 2) return false;
  if (perRow >= 20) return true;
  if (rows < 4 || perRow < 12) return false;
  const words = atoms.flatMap((a) => a.spans.flatMap((s) => s.text.split(/\s+/))).filter(Boolean);
  return words.filter((w) => /^[(["“‘]?\p{Ll}{2,}/u.test(w)).length >= words.length * 0.5;
}
/**
 * Short entries (page numbers, amounts, labels) whose rows sit on the baselines of rows beside
 * them belong to those rows, as in a table of contents or a price list, not to a column.
 */
function rowValues(side: readonly Atom[], other: readonly Atom[], h: number) {
  if (charsPerRow(side) >= 8) return false;
  const bottom = (row: Atom[]) => Math.max(...row.map((a) => a.bbox.y + a.bbox.height));
  const baselines = strips(other).map(bottom),
    rows = strips(side);
  const aligned = rows.filter((row) =>
    baselines.some((b) => Math.abs(b - bottom(row)) <= h * 0.35),
  ).length;
  return aligned >= rows.length * 0.8;
}
/** A reading-order region of atoms. */
interface Region {
  atoms: Atom[];
}
/** Stretches of [from, to] that merged intervals leave uncovered. */
function uncovered(covered: Interval[], from: number, to: number): Interval[] {
  const out: Interval[] = [];
  let x = from;
  for (const [start, end] of covered) {
    if (start > x) out.push([x, start]);
    x = Math.max(x, end);
  }
  if (to > x) out.push([x, to]);
  return out;
}
/** A gutter through consecutive rows of a region: no row from `first` to `last` covers start–end. */
interface Run {
  first: number;
  last: number;
  start: number;
  end: number;
}
/**
 * Gutters that run through consecutive rows: each gap of at least `min` in a row extends up and
 * down while the rows there leave three quarters of that free, narrowing to what they leave (the
 * gutter of a scan drifts by a point or so).
 */
function runs(rows: readonly Atom[][], min: number): Run[] {
  const reach = min * 0.75;
  const from = Math.min(...rows.flat().map((a) => a.bbox.x)),
    to = Math.max(...rows.flat().map((a) => a.bbox.x + a.bbox.width));
  const covered = rows.map((row) => coverage(extents(row)));
  const free = covered.map((c) => uncovered(c, from, to));
  const out: Run[] = [];
  for (const [i, row] of covered.entries())
    for (const gap of gutters(row, min)) {
      let start = gap.start,
        end = gap.start + gap.width;
      // A gap that holds a gutter already running through this row is that gutter.
      if (
        out.some(
          (r) => r.first <= i && i <= r.last && Math.min(r.end, end) - Math.max(r.start, start) > 0,
        )
      )
        continue;
      const extend = (j: number) => {
        let best: Interval | undefined;
        for (const [s, e] of free[j]) {
          const a = Math.max(s, start),
            b = Math.min(e, end);
          if (b - a >= reach && (!best || b - a > best[1] - best[0])) best = [a, b];
        }
        if (best) [start, end] = best;
        return best !== undefined;
      };
      let first = i,
        last = i;
      while (first > 0 && extend(first - 1)) first--;
      while (last < rows.length - 1 && extend(last + 1)) last++;
      out.push({ first, last, start, end });
    }
  return out;
}
/**
 * Atoms grouped into text lines by their tops; a strip can hold the lines of several columns, or
 * all of them when a tall atom such as a turned margin stamp spans them.
 */
function textLines(atoms: readonly Atom[]): Atom[][] {
  const out: Atom[][] = [];
  for (const atom of [...atoms].sort(byPosition)) {
    let row: Atom[] | undefined;
    for (let i = out.length - 1; i >= Math.max(0, out.length - 8) && !row; i--)
      if (sameRow(out[i][0].bbox, atom.bbox)) row = out[i];
    if (row) row.push(atom);
    else out.push([atom]);
  }
  return out;
}
/**
 * Whether a narrow gutter may be word spacing: in OCR text layers that place every word, the
 * gaps between words can be as wide as a gutter, and justified lines line them up into "rivers"
 * for a few lines. A gutter there has to run on for many lines.
 */
function wordSpaced(left: readonly Atom[], right: readonly Atom[]) {
  const sides = new Set(right);
  let twoSided = 0,
    spaced = 0;
  for (const line of textLines([...left, ...right])) {
    const sorted = line.sort((a, b) => a.bbox.x - b.bbox.x);
    const split = sorted.findIndex((a) => sides.has(a));
    if (split <= 0) continue;
    twoSided++;
    const gap = (i: number) => sorted[i].bbox.x - sorted[i - 1].bbox.x - sorted[i - 1].bbox.width;
    let widest = 0;
    for (let i = 1; i < sorted.length; i++) if (i !== split) widest = Math.max(widest, gap(i));
    if (widest >= gap(split) * 0.5) spaced++;
  }
  if (!twoSided || spaced * 2 < twoSided) return false;
  return Math.min(textLines(left).length, textLines(right).length) < 6;
}
/**
 * Whether a row continues the row above it across a gutter, as the last line of a wrapped
 * heading does: one line of the same height, at line spacing, centred under it or left of the
 * gutter (where it is read before the column beside it anyway).
 */
function continues(row: readonly Atom[], above: readonly Atom[], start: number) {
  if (textLines(row).length !== 1 || textLines(above).length !== 1) return false;
  // A row of both columns continues no heading.
  if (sides(row, start).every((side) => side.length)) return false;
  const box = union(row.map((a) => a.bbox)),
    over = union(above.map((a) => a.bbox));
  const centred = Math.abs(box.x + box.width / 2 - (over.x + over.width / 2)) <= over.width * 0.1;
  if (!centred && box.x + box.width > start + 1e-6) return false;
  const top = Math.min(...row.map((a) => a.bbox.y)),
    bottom = Math.max(...above.map((a) => a.bbox.y + a.bbox.height));
  const h = median(row.map((a) => a.bbox.height)),
    hAbove = median(above.map((a) => a.bbox.height));
  return Math.abs(h - hAbove) <= Math.max(h, hAbove) * 0.15 && top - bottom <= h * 0.5;
}
/**
 * Whether a gutter separates columns. Wide gutters do unless one side only holds values for the
 * rows beside it; narrow ones only between prose, or prose and display lettering, so a table
 * with modest spacing keeps reading row by row.
 */
function separates(left: Atom[], right: Atom[], width: number, h: number) {
  if (!left.length || !right.length) return false;
  if (width >= Math.max(30, h * 2)) return !rowValues(left, right, h) && !rowValues(right, left, h);
  if (lettering(left, right) || lettering(right, left)) return true;
  return prose(left) && prose(right) && !wordSpaced(left, right);
}
/**
 * Display lettering down the side of running text (four lines or more), such as a sidebar's
 * title: two lines or more of type at least twice the text's size. (A drop cap, one letter,
 * starts its paragraph.)
 */
function lettering(side: readonly Atom[], text: readonly Atom[]) {
  const size = median(text.map((a) => a.bbox.height));
  return (
    textLines(side.filter((a) => a.bbox.height >= 2 * size)).length >= 2 &&
    textLines(text).length >= 4 &&
    prose(text)
  );
}
/**
 * Whether a gutter through some rows separates columns: as one through all does, with running
 * text on one side at least, or words on both (panels side by side). Figures on a side (a
 * chart's axis beside the values on its bars) read row by row.
 */
function beside(left: Atom[], right: Atom[], width: number, h: number) {
  return (
    separates(left, right, width, h) &&
    (prose(left) || prose(right) || (worded(left) && worded(right)))
  );
}
/** Words of letters, four or more and half the side's tokens at least. */
function worded(atoms: readonly Atom[]) {
  const tokens = atoms.flatMap((a) => a.spans.flatMap((s) => s.text.split(/\s+/))).filter(Boolean);
  const words = tokens.filter((t) => /\p{L}{2}/u.test(t)).length;
  return words >= 4 && words >= tokens.length * 0.5;
}
function sides(atoms: readonly Atom[], start: number): [Atom[], Atom[]] {
  const left: Atom[] = [],
    right: Atom[] = [];
  for (const atom of atoms)
    (atom.bbox.x + atom.bbox.width <= start + 1e-6 ? left : right).push(atom);
  return [left, right];
}
/**
 * Recursive XY-cut. A region is split at the widest vertical gutter that separates columns.
 * Otherwise gutters that run through some of its rows split it into horizontal sections, the
 * tallest first, so a heading, header or caption across a gutter does not merge the columns
 * beside it. Detected tables take part as single units.
 */
function readingOrder(atoms: Atom[], depth = 0): Region[] {
  if (atoms.length < 2 || depth > 64) return [{ atoms }];
  const h = median(atoms.map((a) => a.bbox.height));
  // Compact two-column layouts in small type leave gutters of about one em (7.8 pt at 8 pt).
  const narrow = Math.max(6, h * 0.75);
  for (const gutter of gutters(coverage(extents(atoms)), narrow).sort(
    (a, b) => b.width - a.width,
  )) {
    const [left, right] = sides(atoms, gutter.start);
    const cut = separates(left, right, gutter.width, h);
    if (cut) return [...readingOrder(left, depth + 1), ...readingOrder(right, depth + 1)];
  }
  // Sections: the columns beside the tallest gutters that separate columns in some rows (or all,
  // when a scan's gutter drifts), and the rows between.
  const rows = strips(atoms);
  // A figure set in the middle, the columns' text running down both its sides: its caption
  // blocks the gutter for some rows, set apart by gutters from the text beside it. The gutter
  // above and below it is one; the caption is read after the left column.
  const island = (above: Run, below: Run) => {
    const start = Math.max(above.start, below.start),
      end = Math.min(above.end, below.end);
    if (end <= start || below.first <= above.last + 1) return undefined;
    const between = rows.slice(above.last + 1, below.first).flat();
    // The caption: lines across the gutter, and its lines within their extent.
    const across = between.filter((a) => a.bbox.x < end && a.bbox.x + a.bbox.width > start);
    if (!across.length) return undefined;
    const box = union(across.map((a) => a.bbox)),
      right = box.x + box.width;
    const parts: [Atom[], Atom[], Atom[]] = [[], [], []];
    // Set apart as gutters that runs follow are (three quarters of a narrow one).
    const gap = narrow * 0.75;
    for (const a of between) {
      const x = a.bbox.x,
        end = x + a.bbox.width;
      if (end <= box.x - gap) parts[0].push(a);
      else if (x >= right + gap) parts[2].push(a);
      else if (x >= box.x - 1 && end <= right + 1) parts[1].push(a);
      else return undefined;
    }
    return parts[0].length && parts[2].length
      ? { left: parts[0], middle: parts[1], right: parts[2] }
      : undefined;
  };
  const found = runs(rows, narrow);
  // Candidates: runs, and pairs of runs around such a figure, taken together.
  const candidates: { parts: Run[]; first: number; last: number }[] = found.map((run) => ({
    parts: [run],
    first: run.first,
    last: run.last,
  }));
  for (const above of found)
    for (const below of found)
      if (island(above, below))
        candidates.push({ parts: [above, below], first: above.first, last: below.last });
  const width = (c: (typeof candidates)[number]) =>
    Math.min(...c.parts.map((r) => r.end)) - Math.max(...c.parts.map((r) => r.start));
  // Taken runs; runs of one gutter (`chain`) continue each other, row after row or around a
  // figure.
  const taken: (Run & { chain: number })[] = [];
  // Rows a figure in the middle holds, between the runs around it.
  const held: [number, number][] = [];
  const free = (first: number, last: number) =>
    !taken.some((t) => t.first <= last && first <= t.last) &&
    !held.some(([a, b]) => a <= last && first <= b);
  for (const candidate of candidates.sort(
    (a, b) => b.last - b.first - (a.last - a.first) || width(b) - width(a),
  )) {
    if (candidate.parts.length > 1) {
      // Each run around the figure separates columns on its own.
      const parts = candidate.parts.map((run) => ({ ...run }));
      if (!free(candidate.first, candidate.last)) continue;
      if (
        !parts.every((run) => {
          const [left, right] = sides(rows.slice(run.first, run.last + 1).flat(), run.start);
          return (
            Math.min(textLines(left).length, textLines(right).length) >= 2 &&
            beside(left, right, run.end - run.start, h)
          );
        })
      )
        continue;
      const chain = taken.length;
      for (const run of parts) taken.push({ ...run, chain });
      held.push([parts[0].last + 1, parts[1].first - 1]);
      continue;
    }
    const run = { ...candidate.parts[0] };
    while (
      run.first > 0 &&
      run.first <= run.last &&
      continues(rows[run.first], rows[run.first - 1], run.start)
    )
      run.first++;
    if (run.first > run.last) continue;
    let chain = taken.length;
    if (held.some(([a, b]) => a <= run.last && run.first <= b)) continue;
    const crossed = taken.filter((t) => t.first <= run.last && run.first <= t.last);
    if (crossed.length) {
      // A run beside a taken one continues its gutter past an end when the two overlap: the
      // gutter of a skewed scan drifts by more than one run follows.
      const [t] = crossed;
      if (crossed.length > 1 || Math.min(t.end, run.end) <= Math.max(t.start, run.start)) continue;
      if (run.last > t.last && run.first >= t.first) run.first = t.last + 1;
      else if (run.first < t.first && run.last <= t.last) run.last = t.first - 1;
      else continue;
      if (!free(run.first, run.last)) continue;
      chain = t.chain;
    }
    const [left, right] = sides(rows.slice(run.first, run.last + 1).flat(), run.start);
    // A line read in parts, or one beside a stamp, is still read left to right: columns hold
    // lines on both sides.
    if (Math.min(textLines(left).length, textLines(right).length) < 2) continue;
    if (beside(left, right, run.end - run.start, h)) taken.push({ ...run, chain });
  }
  if (!taken.length) return [{ atoms }];
  const sections: Atom[][] = [];
  let next = 0;
  taken.sort((a, b) => a.first - b.first);
  for (let i = 0; i < taken.length; ) {
    if (taken[i].first > next) sections.push(rows.slice(next, taken[i].first).flat());
    // The columns beside a gutter and the runs continuing it, around a figure in the middle.
    const left: Atom[] = [],
      middle: Atom[] = [],
      right: Atom[] = [];
    let j = i;
    for (; j < taken.length && taken[j].chain === taken[i].chain; j++) {
      const around = j > i ? island(taken[j - 1], taken[j]) : undefined;
      if (around) {
        left.push(...around.left);
        middle.push(...around.middle);
        right.push(...around.right);
      }
      const [l, r] = sides(rows.slice(taken[j].first, taken[j].last + 1).flat(), taken[j].start);
      left.push(...l);
      right.push(...r);
    }
    sections.push(left, ...(middle.length ? [middle] : []), right);
    next = taken[j - 1].last + 1;
    i = j;
  }
  if (next < rows.length) sections.push(rows.slice(next).flat());
  return sections.flatMap((section) => readingOrder(section, depth + 1));
}
/** A line of x-ordered spans: provider words joined by spaces, native runs by measured gaps. */
function textLine(row: TextSpan[], grouped: boolean): TextLine {
  row.sort((a, b) => a.bbox.x - b.bbox.x);
  return {
    text: grouped ? row.map((s) => s.text).join(' ') : lineText(row),
    bbox: union(row.map((s) => s.bbox)),
    spans: row,
  };
}
/**
 * Lines of one reading-order region: pieces of a provider line rejoin when they share the
 * region, and native runs form baseline rows.
 */
function regionLines(atoms: Atom[]): TextLine[] {
  const provided = new Map<object, TextSpan[]>(),
    rows: TextSpan[][] = [];
  for (const atom of atoms)
    if (atom.line) provided.set(atom.line, [...(provided.get(atom.line) ?? []), ...atom.spans]);
  for (const span of atoms
    .filter((a) => !a.line)
    .flatMap((a) => a.spans)
    .sort(byPosition)) {
    // Columns are already separated, so runs on one baseline form one row however far apart
    // they are, such as a table-of-contents entry and its page number (joined by a tab). A row
    // is matched by its widest run: a raised accent or a symbol in another font may come first.
    const row = rows.find((r) => sameRow(widest(r).bbox, span.bbox));
    if (row) row.push(span);
    else rows.push([span]);
  }
  return [
    ...rows.map((row) => textLine(row, false)),
    ...[...provided.values()].map((row) => textLine(row, true)),
  ].sort(byPosition);
}
function atom(spans: TextSpan[], line?: object): Atom {
  return {
    spans,
    bbox: union(spans.map((s) => s.bbox)),
    chars: spans.reduce((n, s) => n + s.text.trim().length, 0),
    line,
  };
}
/**
 * Order spans into blocks of lines by a recursive XY-cut. Detected tables become one block each,
 * with one line per row and tab-separated cells, placed in reading order as single units; their
 * spans are excluded from the remaining layout. `lineOf` keys spans a provider recognized as one
 * line (OCR words), which then stay one line.
 */
export function layout(
  spans: TextSpan[],
  tables: readonly DetectedTable[] = [],
  lineOf?: LineKey,
): TextBlock[] {
  const claimed = new Set(tables.flatMap((t) => t.cellSpans.flat()));
  const atoms: Atom[] = [],
    lines = new Map<object, TextSpan[]>();
  for (const span of spans.filter((s) => s.text.trim() && !claimed.has(s))) {
    const key = lineOf?.(span);
    if (!key) atoms.push(atom([span]));
    else lines.set(key, [...(lines.get(key) ?? []), span]);
  }
  // A recognizer may read straight across a gutter; break its lines at gutter-sized word gaps
  // so the cut can still separate the columns. Pieces left in one region rejoin as one line.
  for (const [key, words] of lines) {
    words.sort((a, b) => a.bbox.x - b.bbox.x);
    const split = Math.max(8, union(words.map((w) => w.bbox)).height * 0.8);
    let piece = [words[0]];
    for (const word of words.slice(1)) {
      const previous = piece[piece.length - 1];
      if (word.bbox.x - previous.bbox.x - previous.bbox.width >= split) {
        atoms.push(atom(piece, key));
        piece = [];
      }
      piece.push(word);
    }
    atoms.push(atom(piece, key));
  }
  for (const [index, detected] of tables.entries())
    atoms.push({
      ...atom(detected.cellSpans.flat()),
      bbox: detected.table.bbox,
      block: tableBlock(detected, index),
    });
  const blocks: TextBlock[] = [];
  const extend = (block: TextBlock, lines: TextLine[]) => {
    block.lines.push(...lines);
    block.text = block.lines.map((l) => l.text).join('\n');
    block.bbox = union(block.lines.map((l) => l.bbox));
  };
  for (const region of readingOrder(atoms)) {
    const regionBlocks: TextBlock[] = region.atoms.flatMap((a) => (a.block ? [a.block] : []));
    let block: TextBlock | undefined;
    for (const line of regionLines(region.atoms.filter((a) => !a.block))) {
      const previous = block?.lines.at(-1);
      if (block && previous && paragraph(previous, line)) extend(block, [line]);
      else {
        block = { text: line.text, bbox: line.bbox, lines: [line] };
        regionBlocks.push(block);
      }
    }
    // Tables take their place among the region's paragraphs from top to bottom.
    for (const next of regionBlocks.sort((a, b) => a.bbox.y - b.bbox.y)) {
      // A paragraph that a region's edge cut (a gutter running on through the empty middle of
      // a panel below the columns) continues in the next region's first block: its sentence
      // goes on there (a header or footer next to the text does not).
      const last = blocks.at(-1),
        [a, b] = [last?.lines.at(-1), next.lines[0]];
      if (
        last &&
        a &&
        b &&
        last.tableIndex === undefined &&
        next.tableIndex === undefined &&
        (/^(\p{Ll}{2}|\p{Ll}\s)/u.test(b.text.trim()) ||
          /\p{L}[-\u00ad\u2010]$/u.test(a.text.trim())) &&
        /\p{L}/u.test(a.text) &&
        b.bbox.y >= a.bbox.y + a.bbox.height * 0.5 &&
        Math.abs(a.bbox.height - b.bbox.height) <= 0.2 * Math.max(a.bbox.height, b.bbox.height) &&
        paragraph(a, b)
      )
        extend(last, next.lines);
      else blocks.push(next);
    }
  }
  return blocks;
}
/**
 * Whether a line continues the paragraph of the line before it: below it by less than about one
 * line height, and side by side with it (a header set right above a body line to its left is
 * not part of its paragraph).
 */
function paragraph(previous: TextLine, line: TextLine) {
  return (
    line.bbox.y - previous.bbox.y - previous.bbox.height <
      Math.max(line.bbox.height, previous.bbox.height) * 0.9 &&
    line.bbox.x < previous.bbox.x + previous.bbox.width &&
    previous.bbox.x < line.bbox.x + line.bbox.width
  );
}
/** Native runs the text layer separates by a space of their own, each to the run after it. */
export const wordBreaks = new WeakMap<TextSpan, TextSpan>();
/**
 * Join x-ordered spans: a space at word gaps or where the text layer has one, a tab at gaps wider
 * than a row may bridge.
 */
function lineText(row: TextSpan[]) {
  let text = '';
  for (const [i, s] of row.entries()) {
    const previous = row[i - 1];
    if (!previous) {
      text = s.text;
      continue;
    }
    const gap = s.bbox.x - previous.bbox.x - previous.bbox.width;
    if (gap > Math.max(30, s.bbox.height * 3)) text += `\t${s.text}`;
    else if (
      (gap > Math.max(1, s.bbox.height * 0.12) ||
        (wordBreaks.get(previous) === s && gap > -s.bbox.height * 0.15)) &&
      !previous.text.endsWith(' ') &&
      !s.text.startsWith(' ')
    )
      text += ` ${s.text}`;
    // Formulas that touch (a script set apart from its base) are one: `$a$$b$` would open
    // display math.
    else if (text.endsWith('$') && s.text.startsWith('$') && previous.text.endsWith('$'))
      text = `${text.slice(0, -1)} ${s.text.slice(1)}`;
    else text += s.text;
  }
  return text;
}
/** One line per non-empty table row; every grid column contributes a tab-separated field. */
function tableBlock({ table, cellSpans }: DetectedTable, tableIndex: number): TextBlock {
  const lines: TextLine[] = [];
  for (let row = 0; row < table.rowCount; row++) {
    const cells = table.cells.flatMap((cell, i) => (cell.row === row ? [{ cell, i }] : []));
    const spans = cells.flatMap(({ i }) => cellSpans[i]);
    if (!spans.length) continue;
    const fields = Array.from({ length: table.columnCount }, (_, column) =>
      (cells.find(({ cell }) => cell.column === column)?.cell.text ?? '').replace(/\s*\n\s*/g, ' '),
    );
    lines.push({
      text: fields.join('\t'),
      bbox: union(cells.map(({ cell }) => cell.bbox)),
      spans,
    });
  }
  return { text: lines.map((l) => l.text).join('\n'), bbox: table.bbox, lines, tableIndex };
}

/** Orientation of a stored raster relative to a placement, from its raster-to-page transform. */
export function orientationOf(imageToPage: AffineTransform): ImageOrientation {
  const [a, b, c, d] = imageToPage;
  const mirrored = a * d - b * c < 0;
  // Page y points down, so atan2 measures clockwise. A mirrored raster's x axis starts at 180°.
  const angle = (Math.atan2(b, a) * 180) / Math.PI - (mirrored ? 180 : 0);
  const rotation = (((Math.round(angle / 90) * 90) % 360) + 360) % 360;
  return { rotation: rotation as ImageOrientation['rotation'], mirrored };
}
/**
 * Maps stored raster pixel edges to the upright raster that displays `orientation` as on the page.
 * The linear part sends the raster's x and y axes to axis-aligned unit vectors.
 */
export function orientationTransform(
  { rotation, mirrored }: ImageOrientation,
  width: number,
  height: number,
): AffineTransform {
  let x = [mirrored ? -1 : 1, 0],
    y = [0, 1];
  // A clockwise quarter turn in y-down coordinates maps (u, v) to (-v, u).
  for (let turn = 0; turn < rotation / 90; turn++) {
    x = [-x[1], x[0]];
    y = [-y[1], y[0]];
  }
  return [
    x[0],
    x[1],
    y[0],
    y[1],
    Math.max(0, -x[0]) * width + Math.max(0, -y[0]) * height,
    Math.max(0, -x[1]) * width + Math.max(0, -y[1]) * height,
  ];
}
export function invert(m: AffineTransform): AffineTransform {
  const det = m[0] * m[3] - m[1] * m[2];
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

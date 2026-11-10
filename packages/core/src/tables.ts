import type { Box, ExtractionWarning, Table, TableCell, TextSpan } from './contracts.js';
import { checkAbort } from './errors.js';
import { intersects, layout, union } from './geometry.js';

/** An axis-aligned ruling line in canonical page points; width is the drawn thickness. */
export interface Rule {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  /** An edge of a shaded area (a cell background) rather than a drawn line. */
  fill?: boolean;
}
/** A public table plus the spans of each cell, parallel to `table.cells`, for text layout. */
export interface DetectedTable {
  table: Table;
  cellSpans: TextSpan[][];
}
/** A merged rule: `pos` is y for horizontal and x for vertical rules, `from`/`to` its extent. */
interface Line {
  pos: number;
  from: number;
  to: number;
}
interface Segment {
  spans: TextSpan[];
  x: number;
  right: number;
  words: number;
}
interface Band {
  y: number;
  bottom: number;
  height: number;
  segments: Segment[];
}
interface Interval {
  from: number;
  to: number;
}

// Distances below are in points for text of REFERENCE_HEIGHT and scale with the height of the
// text they measure (see unitFor): the page's for finding grids, then each grid's, run's or
// band's own, so small print and large type are measured alike.
// Rules closer than this are one grid line; it also absorbs double borders.
const SNAP = 4;
// Median span height that the point values here were tuned for: 10 pt Helvetica, which the
// engine measures as 1.117 em from descent to ascent.
const REFERENCE_HEIGHT = 11.171875;
// Fraction of a ruled grid's cells that must hold text; sparser grids are charts or forms.
const MIN_FILLED_CELLS = 0.5;
// Share of rows starting with a bullet that makes an aligned run a list, not a table. Item
// numbers and letters do not count: they also label table rows.
const LIST_ROWS = 0.8;
const LIST_MARKER = /^[•·∙◦▪▫‣⁃○●■□\-–—*]$/;
// Longest text that counts as an axis label beside a ruled grid.
const MAX_LABEL_LENGTH = 8;
// Rules thicker than this are filled areas rather than lines.
const MAX_RULE_WIDTH = 6;
// Aligned columns whose cells average more words than this read as prose.
const MAX_CELL_WORDS = 6;
/** Words of two letters or more: running text, not figures and units (3 days 5 hours). */
const lettered = (text: string) => text.split(/\s+/).filter((w) => /\p{L}{2}/u.test(w)).length;

/**
 * Tables of one page. Pages failing the cheap pre-check skip the vector-graphics scan that
 * `getRules` performs; when ruling lines are unavailable or truncated, detection degrades to
 * what remains and says so in a warning.
 */
export async function pageTables(
  spans: TextSpan[],
  getRules: () => Promise<{ rules: Rule[]; truncated: boolean }>,
  pageNumber: number,
  signal: AbortSignal,
  /** Detect even when the text does not suggest a table (the page is known to draw rules). */
  force = false,
): Promise<{
  tables: DetectedTable[];
  warnings: ExtractionWarning[];
  /** The page's spans, runs written across a column rule split there. */
  spans: TextSpan[];
  /** Each split part's original span. */
  parts: Map<TextSpan, TextSpan>;
}> {
  let page = prepare(spans);
  const parts = new Map<TextSpan, TextSpan>();
  if (!force && !mayContainTable(spans, page)) return { tables: [], warnings: [], spans, parts };
  const warnings: ExtractionWarning[] = [];
  let rules: Rule[] = [];
  try {
    const found = await getRules();
    rules = found.rules;
    if (found.truncated)
      warnings.push({
        code: 'TABLE_DETECTION_DEGRADED',
        message: 'The page draws too many lines; tables were detected from the first ones only',
        pageNumber,
      });
  } catch (error) {
    checkAbort(signal);
    warnings.push({
      code: 'TABLE_DETECTION_DEGRADED',
      message: `Ruling lines unavailable; tables were detected from text alignment only: ${error}`,
      pageNumber,
    });
  }
  const split = splitAtRules(spans, rules, parts);
  if (split !== spans) page = prepare(split);
  return { tables: detectTables(split, rules, page), warnings, spans: split, parts };
}
/**
 * The spans with native runs that cross a drawn column rule at a space split there: a run
 * written across cells, such as a row number and its label ("1 Increase") over the rule between
 * them. Part positions are estimated from character counts; `parts` maps each to its original.
 * Returns `spans` itself when nothing is split.
 */
export function splitAtRules(
  spans: TextSpan[],
  rules: readonly Rule[],
  parts: Map<TextSpan, TextSpan>,
): TextSpan[] {
  const columns = rules.filter(
    (r) =>
      !r.fill &&
      r.width <= MAX_RULE_WIDTH &&
      Math.abs(r.x1 - r.x2) <= 1 &&
      Math.abs(r.y1 - r.y2) >= 2,
  );
  if (!columns.length) return spans;
  const split = (span: TextSpan, original: TextSpan): TextSpan[] => {
    const { bbox, text } = span,
      middle = bbox.y + bbox.height / 2,
      advance = bbox.width / Math.max(text.length, 1);
    if (!text.includes(' ') || !horizontal(span)) return [span];
    for (const rule of columns) {
      const x = (rule.x1 + rule.x2) / 2;
      if (
        x <= bbox.x + advance ||
        x >= bbox.x + bbox.width - advance ||
        middle < Math.min(rule.y1, rule.y2) - 1 ||
        middle > Math.max(rule.y1, rule.y2) + 1
      )
        continue;
      // The space whose estimated position is nearest the rule, within a character or two.
      let best = -1;
      for (let k = 1; k < text.length - 1; k++)
        if (
          text[k] === ' ' &&
          (best < 0 ||
            Math.abs(bbox.x + (k + 0.5) * advance - x) <
              Math.abs(bbox.x + (best + 0.5) * advance - x))
        )
          best = k;
      if (best < 0 || Math.abs(bbox.x + (best + 0.5) * advance - x) > Math.max(1.5 * advance, 3))
        continue;
      const left = text.slice(0, best).trimEnd(),
        right = text.slice(best + 1).trimStart();
      if (!left || !right) continue;
      const { quad: _quad, ...rest } = span;
      const make = (part: string, from: number, to: number): TextSpan => {
        const piece = { ...rest, text: part, bbox: { ...bbox, x: from, width: to - from } };
        parts.set(piece, original);
        return piece;
      };
      return [
        ...split(make(left, bbox.x, bbox.x + best * advance), original),
        ...split(make(right, bbox.x + (best + 1) * advance, bbox.x + bbox.width), original),
      ];
    }
    return [span];
  };
  let changed = false;
  const out = spans.flatMap((span) => {
    if (span.source !== 'native') return [span];
    const pieces = split(span, span);
    if (pieces.length > 1) changed = true;
    return pieces;
  });
  return changed ? out : spans;
}
/** A page's non-blank spans, their scale and their text rows, computed once per page. */
interface PreparedPage {
  text: TextSpan[];
  u: number;
  bands: ReturnType<typeof bandsOf>;
}
/**
 * Whether a span runs across the page. Text set at a quarter turn (a margin stamp, a rotated
 * citation line) takes no part in a table of horizontal rows.
 */
function horizontal(span: TextSpan) {
  const q = span.quad;
  return !q || Math.abs(q[2] - q[0]) >= Math.abs(q[3] - q[1]);
}
function prepare(spans: TextSpan[]): PreparedPage {
  // Only a few rotated spans (stamps, margin notes) are left out; a page whose text all turns
  // (a rotated page) keeps it.
  const blank = spans.filter((s) => s.text.trim()),
    turned = blank.filter((s) => !horizontal(s)).length,
    text = turned <= blank.length * 0.2 ? blank.filter(horizontal) : blank;
  return { text, u: unitOf(heights(text), 1), bands: bandsOf(text) };
}
/** Detect ruled tables first, then aligned-text tables among the remaining spans. */
/**
 * Tables of a page. Drawn lines are used first. Edges of shaded areas (cell backgrounds, striped
 * rows, colored headers) then outline tables that drawn lines alone do not: a table from the
 * second pass replaces overlapping first-pass tables only when it holds more text, so a grid that
 * lines already describe is kept as is.
 */
export function detectTables(
  spans: TextSpan[],
  rules: readonly Rule[],
  page: PreparedPage = prepare(spans),
): DetectedTable[] {
  const drawn = rules.filter((r) => !r.fill);
  const first = detectWith(drawn, page);
  if (drawn.length === rules.length) return first;
  // Compare by text held, then (for the same text) by filled cells: a finer grid of the same
  // text separates rows that coarser rules merged.
  const sum = (list: DetectedTable[], of: (cell: TextSpan[]) => number) =>
    list.reduce((n, t) => n + t.cellSpans.reduce((m, cell) => m + of(cell), 0), 0);
  const held = (list: DetectedTable[]) => sum(list, (cell) => cell.length),
    filled = (list: DetectedTable[]) => sum(list, (cell) => (cell.length ? 1 : 0));
  const tables = [...first];
  for (const candidate of detectWith(rules, page)) {
    const rivals = tables.filter((t) => intersects(t.table.bbox, candidate.table.bbox));
    const more = held([candidate]) - held(rivals),
      finer = filled([candidate]) - filled(rivals);
    // Same text in as many cells: a grid outlined by shading beats one inferred from alignment.
    const exact =
      candidate.table.detection === 'ruled' && rivals.some((t) => t.table.detection === 'aligned');
    if (more > 0 || (more === 0 && (finer > 0 || (finer === 0 && exact))))
      tables.splice(0, tables.length, ...tables.filter((t) => !rivals.includes(t)), candidate);
  }
  return tables.sort((a, b) => a.table.bbox.y - b.table.bbox.y || a.table.bbox.x - b.table.bbox.x);
}
function detectWith(rules: readonly Rule[], page: PreparedPage): DetectedTable[] {
  const { text, u } = page;
  const horizontal: Line[] = [],
    vertical: Line[] = [];
  for (const r of rules) {
    if (r.width > MAX_RULE_WIDTH) continue;
    if (Math.abs(r.y1 - r.y2) <= 1 && Math.abs(r.x1 - r.x2) >= 2)
      horizontal.push({
        pos: (r.y1 + r.y2) / 2,
        from: Math.min(r.x1, r.x2),
        to: Math.max(r.x1, r.x2),
      });
    else if (Math.abs(r.x1 - r.x2) <= 1 && Math.abs(r.y1 - r.y2) >= 2)
      vertical.push({
        pos: (r.x1 + r.x2) / 2,
        from: Math.min(r.y1, r.y2),
        to: Math.max(r.y1, r.y2),
      });
  }
  const hs = mergeLines(horizontal, u),
    vs = mergeLines(vertical, u);
  // A ruled table whose rules box groups of cells (booktabs, boxed districts) holds a finer
  // grid in its text: when the text inside aligns into more columns, that grid is the table.
  const ruled = ruledTables(text, hs, vs, u).map((t) => finer(t, hs) ?? t);
  const claimed = new Set(ruled.flatMap((t) => t.cellSpans.flat()));
  // A table of contents aligns too: entries end in ascending page numbers, front matter in
  // Roman numerals before the Arabic ones.
  const contents = ({ table }: DetectedTable) => {
    const pages = table.cells
      .filter((c) => c.column === table.columnCount - 1)
      .map((c) => pageNumber(c.text.trim()))
      .filter((page) => page !== undefined);
    return (
      table.rowCount >= 4 &&
      pages.length >= (table.rowCount - 1) * 0.8 &&
      pages.every((page, i) => !i || page >= pages[i - 1])
    );
  };
  // Text rows change only where ruled tables claimed spans.
  const aligned = alignedTables(
    claimed.size ? bandsOf(text.filter((s) => !claimed.has(s))) : page.bands,
    hs,
  ).filter((t) => !contents(t));
  for (const t of aligned)
    for (const cell of t.cellSpans) for (const span of cell) claimed.add(span);
  const banded = bandTables(
    text.filter((s) => !claimed.has(s)),
    hs,
    u,
  );
  return [...ruled, ...aligned, ...banded].sort(
    (a, b) => a.table.bbox.y - b.table.bbox.y || a.table.bbox.x - b.table.bbox.x,
  );
}
/**
 * Cheap pre-check before scanning a page's vector graphics: a table needs a row of three or
 * more segments, or two split rows whose second segments are left- or right-aligned (within a
 * text height). A lone split row, such as a header with a page number, does not qualify.
 */
export function mayContainTable(spans: TextSpan[], page: PreparedPage = prepare(spans)) {
  const seen: { x: number; right: number; height: number }[] = [];
  for (const band of page.bands) {
    if (band.segments.length > 2) return true;
    if (band.segments.length < 2) continue;
    const { x, right } = band.segments[1];
    if (
      seen.some((s) => {
        const tolerance = Math.max(s.height, band.height);
        return Math.abs(s.x - x) <= tolerance || Math.abs(s.right - right) <= tolerance;
      })
    )
      return true;
    seen.push({ x, right, height: band.height });
  }
  return false;
}

/** Scale of text of a height relative to REFERENCE_HEIGHT, for heights clamped to 4-40 pt. */
function unitFor(height: number) {
  return Math.min(40, Math.max(4, height)) / REFERENCE_HEIGHT;
}
/** Scale of the median of text heights, or `fallback` without any. */
function unitOf(textHeights: number[], fallback: number) {
  if (!textHeights.length) return fallback;
  const sorted = [...textHeights].sort((a, b) => a - b);
  return unitFor(sorted[sorted.length >> 1]);
}
/** Joins collinear, touching rules; a sweep over position keeps it linear for sorted input. */
function mergeLines(lines: Line[], u: number) {
  const merged: Line[] = [];
  let start = 0;
  for (const line of [...lines].sort((a, b) => a.pos - b.pos || a.from - b.from)) {
    // Merged lines keep their first position, in ascending order: earlier ones are out of reach.
    while (start < merged.length && merged[start].pos < line.pos - 1.5 * u) start++;
    let last: Line | undefined;
    for (let k = start; k < merged.length && !last; k++) {
      const m = merged[k];
      if (
        Math.abs(m.pos - line.pos) <= 1.5 * u &&
        line.from <= m.to + 2 * u &&
        line.to >= m.from - 2 * u
      )
        last = m;
    }
    if (last) {
      last.from = Math.min(last.from, line.from);
      last.to = Math.max(last.to, line.to);
    } else merged.push({ ...line });
  }
  return merged;
}
function snap(values: number[], u: number) {
  const out: number[] = [];
  for (const value of [...values].sort((a, b) => a - b))
    if (!out.length || value - out[out.length - 1] > SNAP * u) out.push(value);
  return out;
}
/** Fraction of [from, to] covered by lines at `pos`. */
function coverage(lines: Line[], pos: number, from: number, to: number, u: number) {
  const parts = lines
    .filter((l) => Math.abs(l.pos - pos) <= SNAP * u && l.to > from && l.from < to)
    .map((l) => [Math.max(from, l.from), Math.min(to, l.to)])
    .sort((a, b) => a[0] - b[0]);
  let covered = 0,
    end = from;
  for (const [start, stop] of parts) {
    if (stop > end) covered += stop - Math.max(start, end);
    end = Math.max(end, stop);
  }
  return covered / Math.max(to - from, 1e-9);
}
function find(parent: number[], i: number): number {
  while (parent[i] !== i) i = parent[i] = parent[parent[i]];
  return i;
}
/** Index of the grid interval of `edges` containing `value`, or -1 outside. */
function locate(edges: number[], value: number) {
  if (value < edges[0] || value > edges[edges.length - 1]) return -1;
  let i = 0;
  while (i < edges.length - 2 && value >= edges[i + 1]) i++;
  return i;
}
function heights(spans: TextSpan[]) {
  return spans.map((s) => s.bbox.height);
}
/** Whether `inner`'s center lies within `outer`. */
function contains(outer: Box, inner: Box) {
  const x = inner.x + inner.width / 2,
    y = inner.y + inner.height / 2;
  return x >= outer.x && x <= outer.x + outer.width && y >= outer.y && y <= outer.y + outer.height;
}
function box(x1: number, y1: number, x2: number, y2: number): Box {
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}
function cellText(spans: TextSpan[]) {
  const blocks = layout(spans);
  return {
    text: blocks.map((b) => b.text).join('\n'),
    spans: blocks.flatMap((b) => b.lines.flatMap((l) => l.spans)),
  };
}

/**
 * Tables ruled with horizontal lines only whose rows hold too little text for alignment to find
 * them, such as a column left empty except for its header: three or more rules of one width
 * bound the rows (each a few short lines), and the first row's text segments define the columns.
 */
function bandTables(spans: TextSpan[], hs: Line[], u: number): DetectedTable[] {
  const tables: DetectedTable[] = [],
    claimed = new Set<TextSpan>();
  const widths: Line[][] = [];
  for (const rule of [...hs].sort((a, b) => a.pos - b.pos)) {
    const same = widths.find(
      (w) => Math.abs(w[0].from - rule.from) <= SNAP * u && Math.abs(w[0].to - rule.to) <= SNAP * u,
    );
    if (same) same.push(rule);
    else widths.push([rule]);
  }
  for (const rules of widths) {
    if (rules.length < 2) continue;
    const { from, to } = rules[0];
    const within = (top: number, bottom: number) =>
      spans.filter((s) => {
        const cx = s.bbox.x + s.bbox.width / 2,
          cy = s.bbox.y + s.bbox.height / 2;
        return !claimed.has(s) && cx > from && cx < to && cy > top && cy < bottom;
      });
    let run: { rows: TextSpan[][]; top: number; bottom: number } | undefined;
    const flush = () => {
      const table = run && run.rows.length >= 2 ? bandTable(run.rows, from, to, run, u) : undefined;
      if (table) {
        tables.push(table);
        for (const cell of table.cellSpans) for (const span of cell) claimed.add(span);
      }
      run = undefined;
    };
    if (rules.length === 2) {
      // Booktabs: lines between a top and a bottom rule, the first of them the header; or a header
      // line just above the first rule, when the rules frame only the body.
      const body = bandsOf(within(rules[0].pos, rules[1].pos));
      const above = bandsOf(within(rules[0].pos - 3 * REFERENCE_HEIGHT * u, rules[0].pos)).at(-1);
      const rows = body.map((b) => b.spans);
      if (body.length >= 3 && body[0].segments.length >= 2)
        run = { rows, top: rules[0].pos, bottom: rules[1].pos };
      else if (above && rules[0].pos - above.bottom <= above.height && body.length >= 2)
        run = { rows: [above.spans, ...rows], top: above.y, bottom: rules[1].pos };
      flush();
      continue;
    }
    for (let i = 0; i + 1 < rules.length; i++) {
      const row = within(rules[i].pos, rules[i + 1].pos),
        lines = bandsOf(row);
      // Below a header row, lines that each hold several short cells are rows of their own: a
      // booktabs body between a mid and a bottom rule, or rows ruled in groups. Fewer, lines of
      // one cell, or of sentences, are a row's wrapped lines.
      const segments = lines.flatMap((b) => b.segments);
      const rows =
        !!run?.rows.length &&
        lines.length >= (rules.length === 3 ? 2 : 3) &&
        lines.filter((b) => b.segments.length >= 2).length >= lines.length * 0.75 &&
        segments.reduce((n, g) => n + g.words, 0) / segments.length <= 4;
      if (row.length && (rows || lines.length <= 4)) {
        run ??= { rows: [], top: rules[i].pos, bottom: rules[i + 1].pos };
        if (rows) run.rows.push(...lines.map((b) => b.spans));
        else run.rows.push(row);
        run.bottom = rules[i + 1].pos;
      } else flush();
    }
    flush();
  }
  return tables;
}
function bandTable(
  rows: TextSpan[][],
  left: number,
  right: number,
  { top, bottom }: { top: number; bottom: number },
  u: number,
): DetectedTable | undefined {
  const segments = bandsOf(rows[0]).flatMap((b) => b.segments),
    header = project(segments, u);
  // Column names, not numbers: chart value labels between gridlines align too.
  const named = segments.filter(
    (s) =>
      (s.spans
        .map((t) => t.text)
        .join('')
        .match(/\p{L}/gu)?.length ?? 0) >= 2,
  );
  if (header.length < 2 || named.length < 2) return;
  const xs = [left, ...header.slice(1).map((c, i) => (header[i].to + c.from) / 2), right];
  const cells: TableCell[] = [],
    cellSpans: TextSpan[][] = [];
  for (const [row, spans] of rows.entries()) {
    const y1 = Math.min(...spans.map((s) => s.bbox.y)),
      y2 = Math.max(...spans.map((s) => s.bbox.y + s.bbox.height));
    for (let column = 0; column < header.length; column++) {
      const content = cellText(
        spans.filter((s) => locate(xs, s.bbox.x + s.bbox.width / 2) === column),
      );
      // Short entries only: rules between paragraphs are not a table.
      if (content.text.length > 150) return;
      cells.push({
        row,
        column,
        rowSpan: 1,
        columnSpan: 1,
        text: content.text,
        bbox: box(xs[column], y1, xs[column + 1], y2),
      });
      cellSpans.push(content.spans);
    }
  }
  const filled = cells.filter((c) => c.text);
  if (filled.reduce((n, c) => n + c.text.length, 0) / Math.max(1, filled.length) > 60) return;
  // Prose between two rules is no table. A page's columns under a header rule start with lines
  // of running text, not column names; a justified box (words spread to the margins) with
  // lowercase words for names has lines of words reaching across their edges in half the rows.
  const names = segments.map((g) =>
    g.spans
      .map((t) => t.text)
      .join(' ')
      .trim(),
  );
  if (names.some((name) => lettered(name) > MAX_CELL_WORDS)) return;
  const edges = xs.slice(1, -1);
  const across = rows.filter((spans) =>
    spans.some(
      (s) =>
        lettered(s.text) >= 4 &&
        edges.some((x) => s.bbox.x < x - 2 * u && s.bbox.x + s.bbox.width > x + 2 * u),
    ),
  ).length;
  const lowercase = names.filter((name) => /^\p{Ll}{2}/u.test(name)).length;
  if (across >= rows.length * 0.5 && lowercase >= names.length * 0.6) return;
  return {
    table: {
      bbox: box(left, top, right, bottom),
      rowCount: rows.length,
      columnCount: header.length,
      detection: 'aligned',
      cells,
    },
    cellSpans,
  };
}
/** Grids of crossing horizontal and vertical rules; unruled interior edges merge cells. */
function ruledTables(spans: TextSpan[], hs: Line[], vs: Line[], u: number): DetectedTable[] {
  const all = [...hs, ...vs],
    parent = all.map((_, i) => i),
    snapDistance = SNAP * u;
  for (let i = 0; i < hs.length; i++)
    for (let j = 0; j < vs.length; j++) {
      const h = hs[i],
        v = vs[j];
      if (
        v.pos >= h.from - snapDistance &&
        v.pos <= h.to + snapDistance &&
        h.pos >= v.from - snapDistance &&
        h.pos <= v.to + snapDistance
      )
        parent[find(parent, i)] = find(parent, hs.length + j);
    }
  const components = new Map<number, { h: Line[]; v: Line[] }>();
  for (let i = 0; i < all.length; i++) {
    const root = find(parent, i);
    const component = components.get(root) ?? { h: [], v: [] };
    (i < hs.length ? component.h : component.v).push(all[i]);
    components.set(root, component);
  }
  const tables: DetectedTable[] = [],
    claimed = new Set<TextSpan>();
  const candidates = [...components.values()].filter(({ h, v }) => h.length >= 2 && v.length >= 2);
  // Outer edges may be implied by the extent of the other direction's rules.
  const edges = ({ h, v }: { h: Line[]; v: Line[] }, scale: number) => ({
    xs: snap(
      [...v.map((l) => l.pos), Math.min(...h.map((l) => l.from)), Math.max(...h.map((l) => l.to))],
      scale,
    ),
    ys: snap(
      [...h.map((l) => l.pos), Math.min(...v.map((l) => l.from)), Math.max(...v.map((l) => l.to))],
      scale,
    ),
  });
  const bounds = candidates.map((c) => {
    const { xs, ys } = edges(c, u);
    return box(xs[0], ys[0], xs[xs.length - 1], ys[ys.length - 1]);
  });
  for (const [index, component] of candidates.entries()) {
    const { h, v } = component,
      area = bounds[index];
    // Measure the grid with the scale of the text inside it, e.g. a fine-print table on a page
    // of body text.
    const local = unitOf(heights(spans.filter((s) => contains(area, s.bbox))), u),
      { xs, ys } = edges(component, local);
    const rows = ys.length - 1,
      columns = xs.length - 1;
    // One column only as a boxed list of at least four rows (checked once cells are known).
    if (rows < 2 || columns < 1 || (columns === 1 && rows < 4)) continue;
    const grid = Array.from({ length: rows * columns }, (_, i) => i);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < columns; c++) {
        if (c + 1 < columns && coverage(v, xs[c + 1], ys[r], ys[r + 1], local) < 0.5)
          grid[find(grid, r * columns + c)] = find(grid, r * columns + c + 1);
        if (r + 1 < rows && coverage(h, ys[r + 1], xs[c], xs[c + 1], local) < 0.5)
          grid[find(grid, r * columns + c)] = find(grid, (r + 1) * columns + c);
      }
    const groups = new Map<number, number[]>();
    for (let i = 0; i < grid.length; i++) {
      const root = find(grid, i),
        group = groups.get(root);
      if (group) group.push(i);
      else groups.set(root, [i]);
    }
    // A merged area must be rectangular; otherwise keep its grid cells separate. Members are
    // in row-major order, so the last one is the area's bottom-right grid cell.
    const owner = grid.map((_, i) => i),
      members = new Map<number, number[]>();
    for (const group of groups.values()) {
      const rs = group.map((i) => Math.floor(i / columns)),
        cs = group.map((i) => i % columns),
        area = (Math.max(...rs) - Math.min(...rs) + 1) * (Math.max(...cs) - Math.min(...cs) + 1);
      if (area === group.length) {
        for (const i of group) owner[i] = group[0];
        members.set(group[0], group);
      } else for (const i of group) members.set(i, [i]);
    }
    const contents = new Map<number, TextSpan[]>();
    for (const span of spans) {
      if (claimed.has(span)) continue;
      const r = locate(ys, span.bbox.y + span.bbox.height / 2),
        c = locate(xs, span.bbox.x + span.bbox.width / 2);
      if (r < 0 || c < 0) continue;
      const cell = owner[r * columns + c],
        content = contents.get(cell);
      if (content) content.push(span);
      else contents.set(cell, [span]);
    }
    if (contents.size < 2) continue;
    const areas = [...members]
      .sort((a, b) => a[0] - b[0])
      .flatMap(([i, area]) => {
        const row = Math.floor(i / columns),
          column = i % columns;
        const cell = {
          row,
          column,
          rowSpan: Math.floor(area[area.length - 1] / columns) - row + 1,
          columnSpan: (area[area.length - 1] % columns) - column + 1,
          spans: contents.get(i) ?? [],
        };
        if (cell.columnSpan === 1 || !cell.spans.length) return [cell];
        // A cell over several columns whose separate pieces of text each lie within one of
        // them, in two or more, is a row drawn without column rules (a spreadsheet's numbers
        // beside their labels, gridlines only in the header): one cell per column.
        const byColumn = Array.from({ length: cell.columnSpan }, (): TextSpan[] => []);
        for (const segment of bandsOf(cell.spans).flatMap((b) => b.segments)) {
          const c = xs.findIndex(
            (x, k) =>
              k >= column &&
              k < column + cell.columnSpan &&
              segment.x >= x - local &&
              segment.right <= xs[k + 1] + local,
          );
          if (c < 0) return [cell];
          byColumn[c - column].push(...segment.spans);
        }
        return byColumn.filter((c) => c.length).length >= 2
          ? byColumn.map((spans, k) => ({ ...cell, column: column + k, columnSpan: 1, spans }))
          : [cell];
      });
    // Text of the cells one row high, by grid row: what the lines of a taller cell align with.
    const level = Array.from({ length: rows }, (): TextSpan[] => []);
    for (const a of areas) if (a.rowSpan === 1) level[a.row].push(...a.spans);
    const middle = (s: TextSpan) => s.bbox.y + s.bbox.height / 2;
    const placed: { cell: TableCell; spans: TextSpan[] }[] = [];
    for (const a of areas) {
      // A cell over several rows whose lines each sit level with text of their own row, in
      // three or more rows, is a column drawn without row rules (labels beside a ruled value
      // column): one cell per row. A header cell's two lines beside two header rows stay one.
      const byRow = Array.from({ length: a.rowSpan }, (): TextSpan[] => []);
      for (const span of a.spans) byRow[locate(ys, middle(span)) - a.row]?.push(span);
      const split =
        a.rowSpan > 1 &&
        byRow.filter((r) => r.length).length >= 3 &&
        byRow.every(
          (inRow, k) =>
            !inRow.length ||
            inRow.some((s) =>
              level[a.row + k].some(
                (o) =>
                  Math.abs(middle(o) - middle(s)) <= 0.35 * Math.min(o.bbox.height, s.bbox.height),
              ),
            ),
        );
      const parts = split
        ? byRow.map((spans, k) => ({ ...a, row: a.row + k, rowSpan: 1, spans }))
        : [a];
      for (const part of parts) {
        const content = cellText(part.spans);
        placed.push({
          cell: {
            row: part.row,
            column: part.column,
            rowSpan: part.rowSpan,
            columnSpan: part.columnSpan,
            text: content.text,
            bbox: box(
              xs[part.column],
              ys[part.row],
              xs[part.column + part.columnSpan],
              ys[part.row + part.rowSpan],
            ),
          },
          spans: content.spans,
        });
      }
    }
    const cells = placed.map((p) => p.cell);
    const others = bounds.filter((_, i) => i !== index);
    if (
      columns === 1
        ? !boxedList(cells)
        : chartLike(
            cells,
            spans.filter((s) => !others.some((o) => contains(o, s.bbox))),
            xs,
            ys,
          )
    )
      continue;
    const tidy = compact(placed, rows, columns);
    for (const { spans } of tidy.placed) for (const span of spans) claimed.add(span);
    tables.push({
      table: {
        bbox: box(xs[0], ys[0], xs[columns], ys[rows]),
        rowCount: tidy.rows,
        columnCount: tidy.columns,
        detection: 'ruled',
        cells: tidy.placed.map((p) => p.cell),
      },
      cellSpans: tidy.placed.map((p) => p.spans),
    });
  }
  return tables;
}
/**
 * A ruled grid without its empty rows and columns: those where every cell of that row (column)
 * alone is empty. Shading inset from a cell's border, or a spacer row, adds such grid lines;
 * cells across them shrink. At least two rows and columns stay. Cells come back in row-major
 * order.
 */
function compact<T extends { cell: TableCell }>(placed: T[], rows: number, columns: number) {
  const empty = (axis: 'row' | 'column', index: number) => {
    const span = axis === 'row' ? 'rowSpan' : 'columnSpan';
    return placed.every(({ cell }) => cell[axis] !== index || cell[span] > 1 || !cell.text.trim());
  };
  for (const axis of ['row', 'column'] as const) {
    const span = axis === 'row' ? 'rowSpan' : 'columnSpan';
    for (let index = (axis === 'row' ? rows : columns) - 1; index >= 0; index--) {
      if ((axis === 'row' ? rows : columns) <= 2 || !empty(axis, index)) continue;
      placed = placed.filter(({ cell }) => cell[axis] !== index || cell[span] > 1);
      for (const { cell } of placed)
        if (cell[axis] > index) cell[axis]--;
        else if (cell[axis] + cell[span] > index) cell[span]--;
      if (axis === 'row') rows--;
      else columns--;
    }
  }
  placed.sort((a, b) => a.cell.row - b.cell.row || a.cell.column - b.cell.column);
  return { placed, rows, columns };
}
/**
 * Whether a ruled grid reads as a chart (or a sparse form) rather than a table: most cells are
 * empty, text sits in a single row or column, or most horizontal lines carry a short label just
 * outside the grid, like a chart's axis. `spans` excludes text inside other grids, so a
 * neighbouring table's cells are not mistaken for labels.
 */
/**
 * A one-column grid that is a table: a stack of at least four boxes, each holding a short entry
 * (a framework, checklist or option list drawn as boxes), not paragraphs separated by rules.
 */
function boxedList(cells: TableCell[]) {
  return cells.every((c) => c.text && c.text.length <= 120 && c.text.split('\n').length <= 2);
}
function chartLike(cells: TableCell[], spans: TextSpan[], xs: number[], ys: number[]) {
  const filled = cells.filter((c) => c.text);
  // A worksheet (fill-in table) leaves its body empty but labels its header row and first column;
  // a chart's grid has neither inside it.
  const rows = ys.length - 1,
    rowLabel = (row: number) => cells.some((c) => c.row === row && c.column === 0 && c.text);
  const worksheet =
    rows >= 3 &&
    cells.filter((c) => c.row === 0 && (c.text.match(/\p{L}/gu)?.length ?? 0) >= 2).length >= 2 &&
    Array.from({ length: rows - 1 }, (_, r) => rowLabel(r + 1)).filter(Boolean).length >=
      (rows - 1) * 0.8;
  if (
    (filled.length < cells.length * MIN_FILLED_CELLS && !worksheet) ||
    new Set(filled.map((c) => c.row)).size < 2 ||
    new Set(filled.map((c) => c.column)).size < 2
  )
    return true;
  const left = xs[0],
    right = xs[xs.length - 1];
  const labelled = ys.filter((y) =>
    spans.some((s) => {
      const middle = s.bbox.y + s.bbox.height / 2,
        reach = 4 * s.bbox.height;
      return (
        s.text.trim().length <= MAX_LABEL_LENGTH &&
        Math.abs(middle - y) <= 0.75 * s.bbox.height &&
        ((s.bbox.x + s.bbox.width <= left + 1 && s.bbox.x + s.bbox.width >= left - reach) ||
          (s.bbox.x >= right - 1 && s.bbox.x <= right + reach))
      );
    }),
  ).length;
  return labelled >= Math.max(2, ys.length / 2);
}

/** Text rows (same baseline) split into segments at gaps wider than a word space. */
function bandsOf(spans: TextSpan[]) {
  const bands: (Band & { spans: TextSpan[] })[] = [];
  for (const span of [...spans].sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x)) {
    const band = bands.at(-1);
    if (
      band &&
      Math.abs(band.y - span.bbox.y) <=
        Math.max(
          2 * unitFor(Math.min(band.height, span.bbox.height)),
          Math.min(band.height, span.bbox.height) * 0.4,
        )
    ) {
      band.spans.push(span);
      band.bottom = Math.max(band.bottom, span.bbox.y + span.bbox.height);
    } else
      bands.push({
        y: span.bbox.y,
        bottom: span.bbox.y + span.bbox.height,
        height: span.bbox.height,
        segments: [],
        spans: [span],
      });
  }
  // Text set word by word (the invisible layer of a scan) can space its words wider than type
  // does: cells then end at gaps well beyond the page's usual word gap.
  const spread = wordSpacing(bands);
  for (const band of bands) {
    let segment: Segment | undefined;
    for (const span of band.spans.sort((a, b) => a.bbox.x - b.bbox.x)) {
      if (
        segment &&
        span.bbox.x - segment.right <=
          Math.max(3 * unitFor(band.height), 0.5 * band.height, spread * band.height)
      ) {
        segment.spans.push(span);
        segment.right = Math.max(segment.right, span.bbox.x + span.bbox.width);
      } else {
        segment = { spans: [span], x: span.bbox.x, right: span.bbox.x + span.bbox.width, words: 0 };
        band.segments.push(segment);
      }
    }
    for (const s of band.segments)
      s.words = s.spans
        .map((t) => t.text)
        .join(' ')
        .trim()
        .split(/\s+/).length;
  }
  return bands;
}
/**
 * Gap within a cell, in ems, for a stored text layer laid out a word per span (the invisible
 * text of a scan, its words placed in a font that does not match the print): 1.5 times the
 * median gap between neighbouring words, at most 1.2 em. Zero for text in runs (spans of
 * several words), whose gaps between spans are mostly cell gaps, and for recognized words.
 */
function wordSpacing(bands: { height: number; spans: TextSpan[] }[]) {
  let words = 0,
    total = 0;
  const gaps: number[] = [];
  for (const band of bands) {
    // Recognized words are spaced as the scan shows them: only a stored layer qualifies.
    const row = band.spans.filter((s) => s.source === 'native').sort((a, b) => a.bbox.x - b.bbox.x);
    row.forEach((span, k) => {
      total++;
      if (!/\s/.test(span.text.trim())) words++;
      const previous = row[k - 1];
      if (!previous || band.height <= 0) return;
      const gap = (span.bbox.x - previous.bbox.x - previous.bbox.width) / band.height;
      if (gap > 0 && gap < 2) gaps.push(gap);
    });
  }
  if (total < 50 || words < 0.8 * total || gaps.length < 30) return 0;
  gaps.sort((a, b) => a - b);
  return Math.min(1.2, 1.5 * gaps[gaps.length >> 1]);
}
function project(segments: Segment[], u: number) {
  const columns: Interval[] = [];
  for (const s of [...segments].sort((a, b) => a.x - b.x)) {
    const last = columns.at(-1);
    if (last && s.x <= last.to + 2 * u) last.to = Math.max(last.to, s.right);
    else columns.push({ from: s.x, to: s.right });
  }
  return columns;
}

/**
 * The aligned grid inside a ruled table, when it has more columns, at least as many rows and
 * holds most of the table's text: rules drawn around groups of cells, not every cell.
 */
function finer(ruled: DetectedTable, hs: Line[]): DetectedTable | undefined {
  const spans = ruled.cellSpans.flat();
  if (spans.length < 4) return undefined;
  const best = alignedTables(bandsOf(spans), hs).sort(
    (a, b) => b.cellSpans.flat().length - a.cellSpans.flat().length,
  )[0];
  if (!best) return undefined;
  const { table } = best;
  // More columns, or as many and more rows: rules drawn around columns or groups of rows hold
  // rows of their own in their text (a column of figures in one ruled cell). More rows only
  // for short cells (figures, labels): wrapped text in tall cells aligns across columns too.
  const filled = table.cells.filter((c) => c.text.trim()),
    words = filled.reduce(
      (n, c) => n + c.text.split(/\s+/).filter((w) => /\p{L}{2}/u.test(w)).length,
      0,
    );
  // And each ruled row holding several lines holds about as many in each of its filled cells
  // (all of two, three quarters of more): lines of a row, not a cell's text wrapped (a header
  // over two lines beside one-line ones).
  const lines = new Map<number, number[]>();
  ruled.table.cells.forEach((cell, k) => {
    const held = ruled.cellSpans[k] ?? [];
    if (held.length) lines.set(cell.row, [...(lines.get(cell.row) ?? []), bandsOf(held).length]);
  });
  const level = [...lines.values()].every((counts) => {
    const most = Math.max(...counts),
      least = Math.min(...counts);
    return most <= 2 ? least === most : least >= 0.75 * most;
  });
  const more =
    table.columnCount > ruled.table.columnCount ||
    (table.columnCount === ruled.table.columnCount &&
      table.rowCount > ruled.table.rowCount &&
      words <= 2 * filled.length &&
      level);
  return more &&
    table.rowCount >= ruled.table.rowCount &&
    best.cellSpans.flat().length >= spans.length * 0.8
    ? best
    : undefined;
}
/** A page number's position in a book: Roman front matter before Arabic pages. */
function pageNumber(text: string): number | undefined {
  if (/^\d{1,4}$/.test(text)) return Number(text);
  if (!/^[ivxlc]{1,7}$/i.test(text)) return undefined;
  const value: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100 };
  const digits = [...text.toLowerCase()].map((c) => value[c]);
  const total = digits.reduce((n, d, i) => n + (d < (digits[i + 1] ?? 0) ? -d : d), 0);
  return total - 10_000;
}
/**
 * Small grids that are tables though below the usual three rows and columns: two rows of
 * figures across four or more columns (a results summary), or two columns of four or more
 * short entries (names and affiliations, terms and values).
 */
function small(grid: Segment[][][]) {
  const text = (segments: Segment[]) =>
    segments
      .flatMap((s) => s.spans)
      .map((t) => t.text)
      .join(' ')
      .trim();
  const words = (segments: Segment[]) => segments.reduce((n, s) => n + s.words, 0);
  const rows = grid.length,
    columns = grid[0]?.length ?? 0;
  if (rows === 2 && columns >= 4) {
    const values = grid.flatMap((row) => row.slice(1)).filter((cell) => cell.length);
    return (
      values.length >= 2 * (columns - 1) * 0.75 &&
      values.filter((cell) => /\d/.test(text(cell))).length >= values.length * 0.75
    );
  }
  if (columns === 2 && rows >= 4) {
    const cells = grid.flat().filter((cell) => cell.length);
    const counts = cells.map(words);
    // Two columns of running text (a sidebar beside a paragraph): lines that fill their
    // column, words broken at the line end.
    const prose = [0, 1].some((c) => {
      const column = grid.map((row) => row[c]).filter((cell) => cell.length);
      const width = (cell: Segment[]) =>
        Math.max(...cell.map((s) => s.right)) - Math.min(...cell.map((s) => s.x));
      const widest = Math.max(...column.map(width));
      return (
        column.filter((cell) => width(cell) >= 0.85 * widest).length >= column.length * 0.6 &&
        column.reduce((n, cell) => n + words(cell), 0) / column.length > 3
      );
    });
    return (
      !prose &&
      cells.length >= rows * 2 * 0.75 &&
      counts.reduce((n, c) => n + c, 0) / cells.length <= 4 &&
      Math.max(...counts) <= 8 &&
      !cells.some((cell) => /\p{L}-$/u.test(text(cell))) &&
      cells.filter((cell) => /[.;:,]$/.test(text(cell))).length <= cells.length * 0.25
    );
  }
  return false;
}
/** A table caption: "Table 3", "TABLE II." and the like at the start of a row. */
const CAPTION = /^(Table|TABLE|Tab\.)\s+([0-9]+|[IVXLC]+)\b/;
/** Runs of consecutive rows with several aligned text segments, read as tables. */
function alignedTables(bands: Band[], hs: Line[]): DetectedTable[] {
  const tables: DetectedTable[] = [];
  let run: Band[] = [];
  for (const band of bands) {
    const previous = run.at(-1);
    // A caption starts the next table: the rows above it belong to another one.
    const caption = CAPTION.test(
      band.segments[0]?.spans
        .map((t) => t.text)
        .join(' ')
        .trim() ?? '',
    );
    if (
      caption ||
      (previous && band.y - previous.bottom > 2 * Math.max(previous.height, band.height))
    ) {
      tables.push(...fromRun(run, hs));
      run = [];
    }
    if (caption) continue;
    if (run.length || band.segments.length > 1) run.push(band);
  }
  tables.push(...fromRun(run, hs));
  return tables;
}
/**
 * A table from a run of rows. A `split` piece (cut from a rejected run at rows of running
 * text) must look like data: at least four rows, digits in half the cells past the first
 * column.
 */
function fromRun(run: Band[], hs: Line[], split = false): DetectedTable[] {
  run = [...run];
  while (run.length && run[run.length - 1].segments.length < 2) run.pop();
  const multi = run.filter((b) => b.segments.length > 1);
  if (multi.length < 2) return [];
  // The run's own text scale.
  const u = unitOf(
    multi.map((b) => b.height),
    1,
  );
  const columns = project(
    multi.flatMap((b) => b.segments),
    u,
  );
  // A single segment continues the previous row's cell (a wrapped line) when it stays within
  // one column and follows closely. A few words starting the first column, set apart by space
  // or ending in a colon, with a row of the table below, label the rows that follow (Teachers
  // by degree:) between rows alike: a row of its own. Anything else ends the table there.
  const sections = new Set<Band>();
  // Rows of one table: as many segments, give or take one, most of them starting or ending at
  // the same places.
  const alike = (a: Band | undefined, b: Band | undefined) => {
    if (!a || !b || Math.abs(a.segments.length - b.segments.length) > 1) return false;
    const matched = b.segments.filter((s) =>
      a.segments.some((t) => Math.abs(t.x - s.x) <= 2 * u || Math.abs(t.right - s.right) <= 2 * u),
    ).length;
    return matched >= Math.max(2, b.segments.length - 1);
  };
  for (let i = 1; i < run.length; i++) {
    const band = run[i];
    if (band.segments.length > 1) continue;
    const [segment] = band.segments,
      gap = band.y - run[i - 1].bottom,
      inside = columns.some((c) => segment.x >= c.from - u && segment.right <= c.to + u);
    const text = segment.spans
      .map((t) => t.text)
      .join(' ')
      .trim();
    if (
      Math.abs(segment.x - columns[0].from) <= 2 * u &&
      segment.right < (columns[1]?.from ?? Number.POSITIVE_INFINITY) - u &&
      (gap > 0.5 * band.height || text.endsWith(':')) &&
      segment.words <= 10 &&
      // Words, not a figure: a chart's axis values align in columns too.
      /\p{L}{2}/u.test(text) &&
      (run[i + 1]?.segments.length ?? 0) > 1 &&
      alike(
        run.slice(0, i).findLast((b) => b.segments.length > 1),
        run[i + 1],
      )
    ) {
      sections.add(band);
      continue;
    }
    if (!inside || gap > Math.max(band.height, run[i - 1].height))
      return [...fromRun(run.slice(0, i), hs, split), ...fromRun(run.slice(i + 1), hs, split)];
  }
  let table = build(run, columns, hs, u, sections);
  // Headers over several columns (a district over its name and value columns) merge those
  // columns in a projection of all rows. Columns from the rows with the most common number of
  // segments (the data rows) refine an accepted table, the wider cells spanning them.
  if (table) {
    const tally = new Map<number, number>();
    for (const b of multi) tally.set(b.segments.length, (tally.get(b.segments.length) ?? 0) + 1);
    const mode = [...tally].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0],
      shaping = multi.filter((b) => b.segments.length >= mode);
    const finer =
      shaping.length >= 2
        ? project(
            shaping.flatMap((b) => b.segments),
            u,
          )
        : [];
    const refined = finer.length > columns.length ? build(run, finer, hs, u, sections) : undefined;
    // Every column of the finer grid holds text in at least half the rows: stray scripts or
    // marks do not make columns.
    const full =
      refined &&
      finer.every(
        (_, c) =>
          refined.table.cells.filter((cell) => cell.column === c && cell.text.trim()).length >=
          refined.table.rowCount * 0.5,
      );
    if (refined && full) table = refined;
  }
  if (table && split) {
    // Figures, not text that mentions a year: most characters are digits or number marks.
    const figure = (text: string) => {
      const s = text.replace(/\s/g, '');
      return s.length > 0 && s.replace(/[^\d.,%±+\-–]/g, '').length >= s.length * 0.5;
    };
    const values = table.table.cells.filter((c) => c.column > 0 && c.text.trim());
    const data =
      table.table.rowCount >= 4 &&
      values.filter((c) => figure(c.text)).length >= values.length * 0.5;
    return data ? [table] : [];
  }
  if (table) return [table];
  // Rejected as a whole: rows of running text (a two-column page's lines below a table) may
  // have joined it. Split at rows with a prose part, or below the first row (a header) a row
  // of a dozen words however its gaps cut it (a word-spaced scan layer), and try the pieces.
  const prose = (band: Band) =>
    band.segments.length > 1 &&
    (band.segments.some(
      (s) =>
        s.words >= 6 &&
        s.spans
          .map((t) => t.text)
          .join(' ')
          .trim().length >= 35,
    ) ||
      (band !== run[0] &&
        band.segments
          .flatMap((s) => s.spans)
          .flatMap((t) => t.text.split(/\s+/))
          .filter((w) => /\p{L}{2}/u.test(w)).length >= 12));
  const cut = run.findIndex(prose);
  if (cut < 0) return [];
  let end = cut;
  while (end < run.length && prose(run[end])) end++;
  return [...fromRun(run.slice(0, cut), hs, true), ...fromRun(run.slice(end), hs, true)];
}
function build(
  run: Band[],
  columns: Interval[],
  hs: Line[],
  u: number,
  /** Single-segment rows that label the rows below: rows of their own, not wrapped lines. */
  sections: ReadonlySet<Band> = new Set(),
): DetectedTable | undefined {
  const rows: Band[][] = [];
  for (const band of run)
    if (band.segments.length > 1 || sections.has(band) || !rows.length) rows.push([band]);
    else rows[rows.length - 1].push(band);
  const left = columns[0].from,
    right = columns[columns.length - 1].to,
    first = run[0],
    last = run[run.length - 1],
    // A horizontal rule just above the first or below the last row, spanning the columns.
    ruled = (above: boolean) =>
      hs.some(
        (h) =>
          (above
            ? h.pos <= first.y + u && h.pos >= first.y - 2 * first.height
            : h.pos >= last.bottom - u && h.pos <= last.bottom + 2 * last.height) &&
          coverage([h], h.pos, left, right, u) >= 0.8,
      );
  const bounded = ruled(true) && ruled(false);
  // Each segment goes to the column it starts in; one reaching across further columns (a
  // header over a name and a value column) spans them, as a merged cell.
  const grid = rows.map(() => columns.map((): Segment[] => [])),
    spans = rows.map(() => columns.map(() => 1));
  for (const [r, bands] of rows.entries())
    for (const segment of bands.flatMap((b) => b.segments)) {
      let first = columns.findIndex((c) => segment.x <= c.to + u);
      if (first < 0) continue;
      let last = first;
      while (last + 1 < columns.length && columns[last + 1].from - u < segment.right) last++;
      // Inside a merged cell already: it joins that cell.
      const owner = spans[r].findIndex((n, c) => n > 1 && c < first && c + n > first);
      if (owner >= 0) {
        first = owner;
        last = Math.max(last, owner + spans[r][owner] - 1);
      }
      grid[r][first].push(segment);
      if (last > first) {
        spans[r][first] = Math.max(spans[r][first], last - first + 1);
        for (let c = first + 1; c <= last; c++) {
          grid[r][first].push(...grid[r][c]);
          grid[r][c] = [];
          spans[r][c] = 0;
        }
      }
    }
  if ((columns.length < (bounded ? 2 : 3) || rows.length < (bounded ? 2 : 3)) && !small(grid))
    return;
  const open = spans.flat().filter((n) => n > 0).length,
    filled = grid.flat().filter((segments) => segments.length).length;
  if (filled < open * 0.5) return;
  // A first column of bullets or item numbers makes the run a list.
  const markers = grid.filter((row) =>
    LIST_MARKER.test(
      row[0]
        .flatMap((s) => s.spans)
        .map((t) => t.text)
        .join('')
        .trim(),
    ),
  ).length;
  if (markers >= LIST_ROWS * rows.length) return;
  // Reject prose columns: many words per cell, or lines of words that mostly fill the column
  // width (values with units, 3 days 5 hours, fill theirs too).
  for (const [c, column] of columns.entries()) {
    const cells = grid.map((row) => row[c]).filter((segments) => segments.length),
      per = (count: (s: Segment) => number) =>
        cells.reduce((n, segments) => n + segments.reduce((m, s) => m + count(s), 0), 0) /
        Math.max(cells.length, 1),
      average = per((s) => s.words),
      worded = per((s) => lettered(s.spans.map((t) => t.text).join(' '))),
      full = cells.filter((segments) =>
        segments.every((s) => s.right - s.x >= 0.85 * (column.to - column.from)),
      ).length;
    if (average > MAX_CELL_WORDS || (worded > 3 && cells.length >= 3 && full >= 0.7 * cells.length))
      return;
  }
  const xs = [left, ...columns.slice(1).map((c, i) => (columns[i].to + c.from) / 2), right],
    tops = rows.map((bands) => bands[0].y),
    bottoms = rows.map((bands) => Math.max(...bands.map((b) => b.bottom))),
    ys = [
      tops[0],
      ...tops.slice(1).map((top, i) => (bottoms[i] + top) / 2),
      bottoms[rows.length - 1],
    ];
  const cells: TableCell[] = [],
    cellSpans: TextSpan[][] = [];
  for (const [row, segmentsByColumn] of grid.entries())
    for (const [column, segments] of segmentsByColumn.entries()) {
      const span = spans[row][column];
      if (!span) continue;
      const content = cellText(segments.flatMap((s) => s.spans));
      cells.push({
        row,
        column,
        rowSpan: 1,
        columnSpan: span,
        text: content.text,
        bbox: box(xs[column], ys[row], xs[column + span], ys[row + 1]),
      });
      cellSpans.push(content.spans);
    }
  return {
    table: {
      bbox: union(cells.map((c) => c.bbox)),
      rowCount: rows.length,
      columnCount: columns.length,
      detection: 'aligned',
      cells,
    },
    cellSpans,
  };
}

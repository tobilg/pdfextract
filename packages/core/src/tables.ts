import type { Box, ExtractionWarning, Table, TableCell, TextSpan } from './contracts.js';
import { checkAbort } from './errors.js';
import { layout, union } from './geometry.js';

/** An axis-aligned ruling line in canonical page points; width is the drawn thickness. */
export interface Rule {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
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
): Promise<{ tables: DetectedTable[]; warnings: ExtractionWarning[] }> {
  const page = prepare(spans);
  if (!mayContainTable(spans, page)) return { tables: [], warnings: [] };
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
  return { tables: detectTables(spans, rules, page), warnings };
}
/** A page's non-blank spans, their scale and their text rows, computed once per page. */
interface PreparedPage {
  text: TextSpan[];
  u: number;
  bands: ReturnType<typeof bandsOf>;
}
function prepare(spans: TextSpan[]): PreparedPage {
  const text = spans.filter((s) => s.text.trim());
  return { text, u: unitOf(heights(text), 1), bands: bandsOf(text) };
}
/** Detect ruled tables first, then aligned-text tables among the remaining spans. */
export function detectTables(
  spans: TextSpan[],
  rules: readonly Rule[],
  page: PreparedPage = prepare(spans),
): DetectedTable[] {
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
  const ruled = ruledTables(text, hs, vs, u);
  const claimed = new Set(ruled.flatMap((t) => t.cellSpans.flat()));
  // Text rows change only where ruled tables claimed spans.
  const aligned = alignedTables(
    claimed.size ? bandsOf(text.filter((s) => !claimed.has(s))) : page.bands,
    hs,
  );
  return [...ruled, ...aligned].sort(
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
    if (rows < 2 || columns < 2) continue;
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
    const cells: TableCell[] = [],
      cellSpans: TextSpan[][] = [];
    for (const [i, area] of [...members].sort((a, b) => a[0] - b[0])) {
      const row = Math.floor(i / columns),
        column = i % columns,
        rowSpan = Math.floor(area[area.length - 1] / columns) - row + 1,
        columnSpan = (area[area.length - 1] % columns) - column + 1,
        content = cellText(contents.get(i) ?? []);
      cells.push({
        row,
        column,
        rowSpan,
        columnSpan,
        text: content.text,
        bbox: box(xs[column], ys[row], xs[column + columnSpan], ys[row + rowSpan]),
      });
      cellSpans.push(content.spans);
    }
    const others = bounds.filter((_, i) => i !== index);
    if (
      chartLike(
        cells,
        spans.filter((s) => !others.some((o) => contains(o, s.bbox))),
        xs,
        ys,
      )
    )
      continue;
    for (const content of cellSpans) for (const span of content) claimed.add(span);
    tables.push({
      table: {
        bbox: box(xs[0], ys[0], xs[columns], ys[rows]),
        rowCount: rows,
        columnCount: columns,
        detection: 'ruled',
        cells,
      },
      cellSpans,
    });
  }
  return tables;
}
/**
 * Whether a ruled grid reads as a chart (or a sparse form) rather than a table: most cells are
 * empty, text sits in a single row or column, or most horizontal lines carry a short label just
 * outside the grid, like a chart's axis. `spans` excludes text inside other grids, so a
 * neighbouring table's cells are not mistaken for labels.
 */
function chartLike(cells: TableCell[], spans: TextSpan[], xs: number[], ys: number[]) {
  const filled = cells.filter((c) => c.text);
  if (
    filled.length < cells.length * MIN_FILLED_CELLS ||
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
  for (const band of bands) {
    let segment: Segment | undefined;
    for (const span of band.spans.sort((a, b) => a.bbox.x - b.bbox.x)) {
      if (
        segment &&
        span.bbox.x - segment.right <= Math.max(3 * unitFor(band.height), 0.5 * band.height)
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
function project(segments: Segment[], u: number) {
  const columns: Interval[] = [];
  for (const s of [...segments].sort((a, b) => a.x - b.x)) {
    const last = columns.at(-1);
    if (last && s.x <= last.to + 2 * u) last.to = Math.max(last.to, s.right);
    else columns.push({ from: s.x, to: s.right });
  }
  return columns;
}

/** Runs of consecutive rows with several aligned text segments, read as tables. */
function alignedTables(bands: Band[], hs: Line[]): DetectedTable[] {
  const tables: DetectedTable[] = [];
  let run: Band[] = [];
  for (const band of bands) {
    const previous = run.at(-1);
    if (previous && band.y - previous.bottom > 2 * Math.max(previous.height, band.height)) {
      tables.push(...fromRun(run, hs));
      run = [];
    }
    if (run.length || band.segments.length > 1) run.push(band);
  }
  tables.push(...fromRun(run, hs));
  return tables;
}
function fromRun(run: Band[], hs: Line[]): DetectedTable[] {
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
  // one column and follows closely; anything else ends the table there.
  for (let i = 1; i < run.length; i++) {
    const band = run[i];
    if (band.segments.length > 1) continue;
    const [segment] = band.segments,
      inside = columns.some((c) => segment.x >= c.from - u && segment.right <= c.to + u);
    if (!inside || band.y - run[i - 1].bottom > Math.max(band.height, run[i - 1].height))
      return [...fromRun(run.slice(0, i), hs), ...fromRun(run.slice(i + 1), hs)];
  }
  const table = build(run, columns, hs, u);
  return table ? [table] : [];
}
function build(run: Band[], columns: Interval[], hs: Line[], u: number): DetectedTable | undefined {
  const rows: Band[][] = [];
  for (const band of run)
    if (band.segments.length > 1 || !rows.length) rows.push([band]);
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
  if (columns.length < (bounded ? 2 : 3) || rows.length < (bounded ? 2 : 3)) return;
  const grid = rows.map((bands) =>
    columns.map((column) =>
      bands.flatMap((b) =>
        b.segments.filter((s) => s.x >= column.from - u && s.right <= column.to + u),
      ),
    ),
  );
  const filled = grid.flat().filter((segments) => segments.length).length;
  if (filled < rows.length * columns.length * 0.5) return;
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
  // Reject prose columns: many words per cell, or lines that mostly fill the column width.
  for (const [c, column] of columns.entries()) {
    const cells = grid.map((row) => row[c]).filter((segments) => segments.length),
      words = cells.reduce((n, segments) => n + segments.reduce((m, s) => m + s.words, 0), 0),
      average = words / Math.max(cells.length, 1),
      full = cells.filter((segments) =>
        segments.every((s) => s.right - s.x >= 0.85 * (column.to - column.from)),
      ).length;
    if (
      average > MAX_CELL_WORDS ||
      (average > 3 && cells.length >= 3 && full >= 0.7 * cells.length)
    )
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
      const content = cellText(segments.flatMap((s) => s.spans));
      cells.push({
        row,
        column,
        rowSpan: 1,
        columnSpan: 1,
        text: content.text,
        bbox: box(xs[column], ys[row], xs[column + 1], ys[row + 1]),
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

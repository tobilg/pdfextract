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
export function duplicate(ocr: TextSpan, native: readonly TextSpan[]) {
  return native.some(
    (n) =>
      overlap(ocr.bbox, n.bbox) > 0.45 &&
      normalized(ocr.text).length > 0 &&
      ` ${normalized(n.text)} `.includes(` ${normalized(ocr.text)} `),
  );
}
/** Spans on one baseline: the row grouping shared by line building and table detection. */
function sameRow(a: Box, b: Box) {
  return Math.abs(a.y - b.y) <= Math.max(2, Math.min(a.height, b.height) * 0.4);
}
/**
 * Order spans into blocks of lines. Detected tables become one block each, with one line per
 * row and tab-separated cells; their spans are excluded from the remaining layout.
 */
export function layout(spans: TextSpan[], tables: readonly DetectedTable[] = []): TextBlock[] {
  const claimed = new Set(tables.flatMap((t) => t.cellSpans.flat()));
  // Geometric rows; split widely separated columns into independent blocks.
  const rows: TextSpan[][] = [];
  for (const span of spans
    .filter((s) => s.text.trim() && !claimed.has(s))
    .sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x)) {
    const row = rows.find(
      (r) =>
        sameRow(r[0].bbox, span.bbox) &&
        span.bbox.x <=
          Math.max(...r.map((s) => s.bbox.x + s.bbox.width)) + Math.max(30, span.bbox.height * 3),
    );
    if (row) row.push(span);
    else rows.push([span]);
  }
  const lines = rows.map((row) => {
    row.sort((a, b) => a.bbox.x - b.bbox.x);
    return { text: lineText(row), bbox: union(row.map((s) => s.bbox)), spans: row };
  });
  const units: { bbox: Box; line?: TextLine; table?: TextBlock }[] = [
    ...lines.map((line) => ({ bbox: line.bbox, line })),
    ...tables.map((t, index) => ({ bbox: t.table.bbox, table: tableBlock(t, index) })),
  ];
  // Separate columns only when there is a continuous vertical gutter. A heading
  // spanning the gutter intentionally falls back to top-to-bottom row order.
  const columns: (typeof units)[] = [];
  for (const unit of [...units].sort((a, b) => a.bbox.x - b.bbox.x)) {
    const last = columns.at(-1);
    const right = last ? Math.max(...last.map((u) => u.bbox.x + u.bbox.width)) : 0;
    const gutter = Math.max(30, unit.line ? unit.bbox.height * 2 : 0);
    if (last && unit.bbox.x - right <= gutter) last.push(unit);
    else columns.push([unit]);
  }
  const blocks: TextBlock[] = [];
  for (const column of columns) {
    column.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
    let block: TextBlock | undefined;
    for (const unit of column) {
      if (unit.table) {
        blocks.push(unit.table);
        block = undefined;
        continue;
      }
      const line = unit.line as TextLine;
      const previous = block?.lines.at(-1);
      if (block && previous && sameRow(previous.bbox, line.bbox)) {
        // Fragments of one row separated by a wide gap (e.g. undetected table cells) stay
        // one line, read left to right with a tab between fragments.
        previous.spans = [...previous.spans, ...line.spans].sort((a, b) => a.bbox.x - b.bbox.x);
        previous.text = lineText(previous.spans);
        previous.bbox = union([previous.bbox, line.bbox]);
      } else if (
        block &&
        previous &&
        line.bbox.y - previous.bbox.y - previous.bbox.height <
          Math.max(line.bbox.height, previous.bbox.height) * 0.9
      )
        block.lines.push(line);
      else {
        block = { text: '', bbox: line.bbox, lines: [line] };
        blocks.push(block);
      }
      block.text = block.lines.map((l) => l.text).join('\n');
      block.bbox = union(block.lines.map((l) => l.bbox));
    }
  }
  return blocks;
}
/** Join x-ordered spans: a space at word gaps, a tab at gaps wider than a row may bridge. */
function lineText(row: TextSpan[]) {
  return row
    .map((s, i) => {
      const previous = row[i - 1];
      if (!previous) return s.text;
      const gap = s.bbox.x - previous.bbox.x - previous.bbox.width;
      if (gap > Math.max(30, s.bbox.height * 3)) return `\t${s.text}`;
      return `${gap > Math.max(1, s.bbox.height * 0.12) && !previous.text.endsWith(' ') && !s.text.startsWith(' ') ? ' ' : ''}${s.text}`;
    })
    .join('');
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

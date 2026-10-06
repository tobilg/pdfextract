import type { AffineTransform, Box, TextBlock, TextSpan } from './contracts.js';
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
export function duplicate(ocr: TextSpan, native: TextSpan[]) {
  return native.some(
    (n) =>
      overlap(ocr.bbox, n.bbox) > 0.45 &&
      normalized(ocr.text).length > 0 &&
      ` ${normalized(n.text)} `.includes(` ${normalized(ocr.text)} `),
  );
}
export function layout(spans: TextSpan[]): TextBlock[] {
  // Geometric rows; split widely separated columns into independent blocks.
  const rows: TextSpan[][] = [];
  for (const span of spans
    .filter((s) => s.text.trim())
    .sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x)) {
    const row = rows.find(
      (r) =>
        Math.abs(r[0].bbox.y - span.bbox.y) <=
          Math.max(2, Math.min(r[0].bbox.height, span.bbox.height) * 0.4) &&
        span.bbox.x <=
          Math.max(...r.map((s) => s.bbox.x + s.bbox.width)) + Math.max(30, span.bbox.height * 3),
    );
    if (row) row.push(span);
    else rows.push([span]);
  }
  const lines = rows.map((row) => {
    row.sort((a, b) => a.bbox.x - b.bbox.x);
    const text = row
        .map((s, i) => {
          const previous = row[i - 1];
          const gap = previous ? s.bbox.x - previous.bbox.x - previous.bbox.width : 0;
          return `${previous && gap > Math.max(1, s.bbox.height * 0.12) && !previous.text.endsWith(' ') && !s.text.startsWith(' ') ? ' ' : ''}${s.text}`;
        })
        .join(''),
      bbox = union(row.map((s) => s.bbox));
    return { text, bbox, spans: row };
  });
  // Separate columns only when there is a continuous vertical gutter. A heading
  // spanning the gutter intentionally falls back to top-to-bottom row order.
  const columns: (typeof lines)[] = [];
  for (const line of [...lines].sort((a, b) => a.bbox.x - b.bbox.x)) {
    const last = columns.at(-1);
    const right = last ? Math.max(...last.map((l) => l.bbox.x + l.bbox.width)) : 0;
    if (last && line.bbox.x - right <= Math.max(30, line.bbox.height * 2)) last.push(line);
    else columns.push([line]);
  }
  const blocks: TextBlock[] = [];
  for (const column of columns) {
    column.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
    let block: TextBlock | undefined;
    for (const line of column) {
      const previous = block?.lines.at(-1);
      if (
        block &&
        previous &&
        line.bbox.y - previous.bbox.y - previous.bbox.height <
          Math.max(line.bbox.height, previous.bbox.height) * 0.9
      ) {
        block.lines.push(line);
        block.text = block.lines.map((l) => l.text).join('\n');
        block.bbox = union(block.lines.map((l) => l.bbox));
      } else {
        block = { text: line.text, bbox: line.bbox, lines: [line] };
        blocks.push(block);
      }
    }
  }
  return blocks;
}

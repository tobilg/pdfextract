// @ts-check
// Collectors fed by the walker: image inventory, overlay detection and ruling lines.

// Inventory entries for each image draw; with data.decodeId, stops at that image's first draw.
/**
 * @param {ImageItem[]} images
 * @param {ScanRequest} data
 */
function pdfextractImageCollector(images, data) {
  /** @type {ImageInfo[]} */
  const out = [];
  /** @type {{ info: ImageInfo; item: ImageItem } | undefined} */
  let target;
  return {
    /** @type {NonNullable<Collector['image']>} */
    image({ index }, state) {
      const item = images[index],
        dict = item.image.dict,
        stencil = !!dict.get('IM', 'ImageMask');
      const width = dict.get('W', 'Width'),
        height = dict.get('H', 'Height');
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
        throw new Error('RESOURCE_LIMIT_EXCEEDED: Invalid image dimensions');
      const ref = dict.objId ?? `inline-${data.pageIndex}-${index}`;
      const id = `${ref}${stencil ? `-${state.fill.join('-')}` : ''}${state.variant}`;
      /** @type {ImageInfo} */
      const info = {
        id,
        width,
        height,
        bitsPerComponent: dict.get('BPC', 'BitsPerComponent') ?? 1,
        colorSpace: String(dict.get('CS', 'ColorSpace')?.name ?? 'complex'),
        hasAlpha: stencil || dict.has('SMask') || dict.has('Mask'),
        matrix: state.matrix.slice(),
        // Clipped unless the clip is an exact rectangle containing the whole image.
        clipped:
          state.clipped &&
          !(
            state.clipExact &&
            pdfextractContains(state.clip, pdfextractBox(state.matrix, 0, 0, 1, 1, 0), 0.5)
          ),
        unsupported: state.unsupported,
        index,
        stencil,
        fill: state.fill.slice(),
        // Earlier draws on this page with the same placement and raster size, to find this
        // draw when rendering (composite.ts matches both).
        stack: out.filter(
          (o) =>
            o.width === width &&
            o.height === height &&
            o.matrix.every((v, k) => Math.abs(v - state.matrix[k]) < 1e-6),
        ).length,
      };
      out.push(info);
      if (data.decodeId === id) {
        target = { info, item };
        return true;
      }
    },
    result: () => out,
    target: () => target,
  };
}
// Marks images as overlaid when a later visible paint intersects them. Images not yet marked
// are indexed in a coarse grid, so each paint only tests images near it.
function pdfextractOverlayCollector() {
  const CELL = 64,
    MAX_CELLS = 256;
  /** @type {(BoxTuple | null)[]} */
  const boxes = [];
  /** @type {boolean[]} */
  const overlaid = [];
  /** @type {Map<string, number[]>} */
  const cells = new Map();
  // Images spanning too many cells, tested by every paint.
  /** @type {number[]} */
  const large = [];
  /** @type {(box: BoxTuple) => BoxTuple | undefined} */
  const range = (box) => {
    const x0 = Math.floor(box[0] / CELL),
      y0 = Math.floor(box[1] / CELL),
      x1 = Math.floor(box[2] / CELL),
      y1 = Math.floor(box[3] / CELL);
    return (x1 - x0 + 1) * (y1 - y0 + 1) <= MAX_CELLS ? [x0, y0, x1, y1] : undefined;
  };
  /** @type {(box: BoxTuple, i: number) => void} */
  const test = (box, i) => {
    const target = boxes[i];
    if (!overlaid[i] && target && pdfextractOverlap(box, target)) overlaid[i] = true;
  };
  /** @type {(box: BoxTuple | null) => void} */
  const paint = (box) => {
    if (!box) return;
    const cellRange = range(box);
    if (!cellRange) {
      for (let i = 0; i < boxes.length; i++) test(box, i);
      return;
    }
    for (const i of large) test(box, i);
    const [x0, y0, x1, y1] = cellRange;
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const key = `${x},${y}`,
          cell = cells.get(key);
        if (!cell) continue;
        for (const i of cell) test(box, i);
        const live = cell.filter((i) => !overlaid[i]);
        if (live.length) cells.set(key, live);
        else cells.delete(key);
      }
  };
  // A stroke-only straight path covers its segments, not the area they enclose (e.g. a frame).
  /** @type {(event: { subpaths: Subpath[]; width: number }, state: WalkState) => void} */
  const strokes = ({ subpaths, width }, state) => {
    for (const { points, closed } of subpaths)
      for (let i = 1; i <= points.length - (closed ? 0 : 1); i++) {
        const [x1, y1] = points[i - 1],
          [x2, y2] = points[i % points.length];
        paint(
          pdfextractIntersect(
            [
              Math.min(x1, x2) - width / 2,
              Math.min(y1, y2) - width / 2,
              Math.max(x1, x2) + width / 2,
              Math.max(y1, y2) + width / 2,
            ],
            state.clip,
          ),
        );
      }
  };
  return {
    /** @type {NonNullable<Collector['path']>} */
    path(event, state) {
      const { subpaths } = event;
      if (event.stroke && !event.fill && subpaths?.every((s) => !s.curved))
        strokes({ subpaths, width: event.width }, state);
      else paint(event.box);
    },
    /** @type {NonNullable<Collector['text']>} */
    text({ box }) {
      paint(box);
    },
    /** @type {NonNullable<Collector['shading']>} */
    shading({ box }) {
      paint(box);
    },
    /** @type {NonNullable<Collector['image']>} */
    image({ box }) {
      paint(box);
      const i = boxes.push(box) - 1;
      overlaid.push(false);
      if (!box) return;
      const cellRange = range(box);
      if (!cellRange) {
        large.push(i);
        return;
      }
      const [x0, y0, x1, y1] = cellRange;
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++) {
          const key = `${x},${y}`;
          cells.set(key, [...(cells.get(key) ?? []), i]);
        }
    },
    result: () => overlaid,
  };
}
const PDFEXTRACT_MAX_RULES = 5000;
// Collects axis-aligned ruling lines in PDF space for table detection: stroked straight
// segments and thin filled rectangles (drawn as their center line). Curves, white paint and
// clipped-away parts are skipped. `truncated` reports hitting PDFEXTRACT_MAX_RULES.
function pdfextractRuleCollector() {
  /** @type {RuleLine[]} */
  const rules = [];
  let truncated = false;
  // Clips an axis-aligned rule to the clip box; drops it when nothing is left.
  /** @type {(rule: RuleLine, clip: BoxTuple | null) => void} */
  const add = (rule, clip) => {
    if (!clip) return;
    const horizontal = Math.abs(rule.y1 - rule.y2) <= Math.abs(rule.x1 - rule.x2);
    const [from, to, pos] = horizontal
      ? [
          Math.max(Math.min(rule.x1, rule.x2), clip[0]),
          Math.min(Math.max(rule.x1, rule.x2), clip[2]),
          (rule.y1 + rule.y2) / 2,
        ]
      : [
          Math.max(Math.min(rule.y1, rule.y2), clip[1]),
          Math.min(Math.max(rule.y1, rule.y2), clip[3]),
          (rule.x1 + rule.x2) / 2,
        ];
    if (to - from < 0.5 || pos < clip[horizontal ? 1 : 0] || pos > clip[horizontal ? 3 : 2]) return;
    if (rules.length >= PDFEXTRACT_MAX_RULES) {
      truncated = true;
      return;
    }
    rules.push(
      horizontal
        ? { x1: from, y1: pos, x2: to, y2: pos, width: rule.width }
        : { x1: pos, y1: from, x2: pos, y2: to, width: rule.width },
    );
  };
  // Near-white paint (e.g. a background or a knockout bar) draws no visible line.
  /** @type {(color: number[], pattern: boolean) => boolean} */
  const visible = (color, pattern) => pattern || color.some((c) => c < 250);
  return {
    /** @type {NonNullable<Collector['path']>} */
    path({ stroke, fill, subpaths, width }, state) {
      if (!subpaths || truncated) return;
      const stroked = stroke && visible(state.stroke, state.strokePattern),
        filled = fill && visible(state.fill, state.fillPattern);
      if (!stroked && !filled) return;
      for (const { points, curved, closed } of subpaths) {
        if (curved) continue;
        if (stroked)
          for (let i = 1; i <= points.length - (closed ? 0 : 1); i++) {
            const [x1, y1] = points[i - 1],
              [x2, y2] = points[i % points.length];
            if ((Math.abs(x1 - x2) <= 0.5 || Math.abs(y1 - y2) <= 0.5) && (x1 !== x2 || y1 !== y2))
              add({ x1, y1, x2, y2, width }, state.clip);
          }
        if (filled && points.length >= 4 && points.length <= 5) {
          const xs = points.map((p) => p[0]),
            ys = points.map((p) => p[1]),
            left = Math.min(...xs),
            right = Math.max(...xs),
            bottom = Math.min(...ys),
            top = Math.max(...ys),
            rectangular = points.every(
              ([x, y]) =>
                (Math.abs(x - left) <= 0.5 || Math.abs(x - right) <= 0.5) &&
                (Math.abs(y - bottom) <= 0.5 || Math.abs(y - top) <= 0.5),
            );
          if (!rectangular) continue;
          const w = right - left,
            h = top - bottom,
            middleY = (top + bottom) / 2,
            middleX = (left + right) / 2;
          if (h <= 4 && w > h)
            add({ x1: left, y1: middleY, x2: right, y2: middleY, width: h }, state.clip);
          else if (w <= 4 && h > w)
            add({ x1: middleX, y1: bottom, x2: middleX, y2: top, width: w }, state.clip);
        }
      }
    },
    /** @returns {PageRules} */
    result: () => ({ rules, truncated }),
  };
}

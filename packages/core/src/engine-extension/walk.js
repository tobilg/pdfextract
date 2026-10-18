// @ts-check
// The operator-list walker and its geometry helpers.

/** @type {(m: Matrix, n: Matrix) => Matrix} */
const pdfextractMultiply = (m, n) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
/**
 * Walks an operator list once, tracking the graphics and text state, and reports paint events
 * to collectors as `collector[event](payload, state)`:
 * - path: { op, stroke, fill, subpaths, box, width } for painted paths; subpaths hold PDF-space
 *   points (undefined when the path cannot be parsed), width is the PDF-space stroke width
 * - text: { box } for shown text
 * - shading: { box } for shading fills
 * - image: { index, box } for image draws (operator 1001)
 * Boxes are [x0, y0, x1, y1] in PDF space, intersected with the current clip box (`state.clip`),
 * or null when clipped away entirely. A collector returning true stops the walk.
 */
/**
 * @param {{ fnArray: number[]; argsArray: any[] }} list
 * @param {Collector[]} collectors
 * @param {Map<string, FontMetrics>} [fonts] Metrics by loaded font name.
 */
function pdfextractWalk(list, collectors, fonts = new Map()) {
  /** @type {WalkState} */
  let state = {
    matrix: [1, 0, 0, 1, 0, 0],
    fill: [0, 0, 0],
    stroke: [0, 0, 0],
    // Fill or stroke with a pattern or shading instead of a plain color.
    fillPattern: false,
    strokePattern: false,
    // Bounds of the clip path. Text clips leave it unchanged but make it inexact.
    clip: PDFEXTRACT_UNBOUNDED,
    clipped: false,
    clipExact: true,
    unsupported: false,
    variant: '',
    lineWidth: 1,
    font: 0,
    fontName: undefined,
    charSpacing: 0,
    wordSpacing: 0,
    hScale: 1,
    leading: 0,
    rise: 0,
    textMode: 0,
  };
  // Text position is not part of the saved graphics state.
  const text = { matrix: [1, 0, 0, 1, 0, 0], x: 0, y: 0, lineX: 0, lineY: 0 };
  /** @type {WalkState[]} */
  const stack = [];
  // PDF.js emits clip before the path that defines it (`re W n`).
  let pendingClip = false;
  // Text shown with a clipping mode (4-7) adds to the clip when the text object ends.
  let pendingTextClip = false;
  /**
   * @template {'path' | 'text' | 'shading' | 'image'} E
   * @param {E} event
   * @param {Parameters<NonNullable<Collector[E]>>[0]} payload
   */
  const emit = (event, payload) =>
    collectors.some(
      (collector) =>
        /** @type {((e: typeof payload, s: WalkState) => boolean | void) | undefined} */ (
          collector[event]
        )?.(payload, state) === true,
    );
  // Events no collector handles are not computed (e.g. text extents in a decode-only scan).
  const wantsPaths = collectors.some((c) => c.path),
    wantsText = collectors.some((c) => c.text);
  /** @type {(x: number, y: number) => void} */
  const moveText = (x, y) => {
    text.x = text.lineX += x;
    text.y = text.lineY += y;
  };
  /** @type {(paint: number, path: ArrayLike<number> | null, minMax: BoxTuple) => boolean} */
  const emitPath = (paint, path, minMax) => {
    const m = state.matrix;
    return emit('path', {
      op: paint,
      stroke: pdfextractStrokes.has(paint),
      fill: pdfextractFills.has(paint),
      subpaths: pdfextractSubpaths(m, path),
      box: pdfextractIntersect(pdfextractBox(m, ...minMax, state.lineWidth / 2), state.clip),
      width: state.lineWidth * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])),
    });
  };
  for (let i = 0; i < list.fnArray.length; i++) {
    const op = list.fnArray[i],
      args = list.argsArray[i];
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
      stack.push(structuredClone(state));
      if (op === OPS.paintFormXObjectBegin) {
        // Arguments: the form's matrix and BBox, either possibly null.
        const [formMatrix, bbox] = /** @type {[Matrix | null, BoxTuple | null]} */ (args);
        if (formMatrix) state.matrix = pdfextractMultiply(state.matrix, formMatrix);
        if (bbox) {
          state.clipped = true;
          state.clip = pdfextractIntersect(state.clip, pdfextractBox(state.matrix, ...bbox, 0));
          // The BBox stays an axis-aligned rectangle only without rotation (or by quarter turns).
          if (!pdfextractAxisAligned(state.matrix)) state.clipExact = false;
        }
      }
    } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) state = stack.pop() ?? state;
    else if (op === OPS.transform) state.matrix = pdfextractMultiply(state.matrix, args);
    else if (op === OPS.clip || op === OPS.eoClip) {
      state.clipped = true;
      pendingClip = true;
    } else if (op === OPS.setFillRGBColor) {
      state.fill = Array.from(args);
      state.fillPattern = false;
    } else if (op === OPS.setStrokeRGBColor) {
      state.stroke = Array.from(args);
      state.strokePattern = false;
    } else if (op === OPS.setFillColorN) state.fillPattern = true;
    else if (op === OPS.setStrokeColorN) state.strokePattern = true;
    else if (op === OPS.setLineWidth) state.lineWidth = args[0];
    else if (op === OPS.constructPath) {
      // Arguments: the paint operator, [path buffer or null], and the path's bounds (or null).
      const [paint, [path], minMax] =
          /** @type {[number, [ArrayLike<number> | null], BoxTuple | null]} */ (args),
        m = state.matrix;
      if (pendingClip) {
        // The clip applies after this path is painted, and an empty path clips everything away.
        pendingClip = false;
        const clip = minMax
            ? pdfextractIntersect(state.clip, pdfextractBox(m, ...minMax, 0))
            : null,
          exact = !minMax || pdfextractRectangle(pdfextractSubpaths(m, path));
        if (paint !== OPS.endPath && minMax && wantsPaths && emitPath(paint, path, minMax)) return;
        state.clip = clip;
        if (!exact) state.clipExact = false;
        continue;
      }
      if (paint === OPS.endPath || !minMax || !wantsPaths) continue;
      if (emitPath(paint, path, minMax)) return;
    } else if (op === OPS.shadingFill) {
      // A shading fills the whole clip area.
      if (emit('shading', { box: state.clip })) return;
    } else if (op === OPS.beginText) {
      text.matrix = [1, 0, 0, 1, 0, 0];
      text.x = text.y = text.lineX = text.lineY = 0;
    } else if (op === OPS.endText) {
      if (pendingTextClip) {
        pendingTextClip = false;
        state.clipped = true;
        state.clipExact = false;
      }
    } else if (op === OPS.setTextMatrix) {
      text.matrix = Array.from(args.length === 1 ? args[0] : args);
      text.x = text.y = text.lineX = text.lineY = 0;
    } else if (op === OPS.moveText) moveText(args[0], args[1]);
    else if (op === OPS.setLeadingMoveText) {
      state.leading = args[1];
      moveText(args[0], args[1]);
    } else if (op === OPS.setLeading) state.leading = -args[0];
    else if (op === OPS.nextLine) moveText(0, state.leading);
    else if (op === OPS.setFont) {
      state.fontName = args[0];
      state.font = args[1];
    } else if (op === OPS.setCharSpacing) state.charSpacing = args[0];
    else if (op === OPS.setWordSpacing) state.wordSpacing = args[0];
    else if (op === OPS.setHScale) state.hScale = args[0] / 100;
    else if (op === OPS.setTextRise) state.rise = args[0];
    else if (op === OPS.setTextRenderingMode) state.textMode = args[0];
    else if (op === OPS.showText) {
      if (state.textMode >= 4) pendingTextClip = true;
      if (!wantsText) continue;
      const box = pdfextractShowText(
        /** @type {(number | { width?: number; isSpace?: boolean; vmetric?: number[] })[]} */ (
          args[0]
        ),
        state,
        text,
        state.fontName === undefined ? undefined : fonts.get(state.fontName),
      );
      // Modes 3 (invisible, e.g. OCR layers) and 7 (clip only) paint nothing.
      if (state.textMode === 3 || state.textMode === 7) continue;
      if (emit('text', { box: pdfextractIntersect(box, state.clip) })) return;
    } else if (op === OPS.setGState) {
      for (const [key, value] of args[0])
        if (key === 'LW') state.lineWidth = value;
        else if (key === 'Font') {
          state.fontName = value[0];
          state.font = value[1];
        } else if (
          (key === 'SMask' && value) ||
          (key === 'BM' && value !== 'source-over') ||
          (key === 'ca' && value !== 1)
        ) {
          state.unsupported = true;
          state.variant += JSON.stringify([key, value]);
        }
    } else if (op === 1001) {
      const box = pdfextractIntersect(pdfextractBox(state.matrix, 0, 0, 1, 1, 0), state.clip);
      if (emit('image', { index: args[0], box })) return;
    }
  }
}
/**
 * Advances the text position over shown glyphs the way the renderer does and returns their
 * estimated extent in PDF space: 0.8 em above and 0.2 em below the baseline for horizontal
 * text, 0.5 em either side of the line for vertical text. Every shown text has metrics: PDF.js
 * substitutes a fallback for missing or broken fonts, and image scans fail on text shown before
 * any font is set. The 1/1000 em default only guards against an engine change.
 * @param {(number | { width?: number; isSpace?: boolean; vmetric?: number[] })[]} glyphs
 * @param {WalkState} state
 * @param {{ matrix: number[]; x: number; y: number }} text
 * @param {FontMetrics | undefined} font
 * @returns {BoxTuple}
 */
function pdfextractShowText(glyphs, state, text, font) {
  const size = state.font,
    em = Math.abs(size),
    m = pdfextractMultiply(state.matrix, text.matrix),
    startX = text.x,
    startY = text.y;
  const scale = size * (font ? font.matrix[0] : 0.001);
  let advance = 0;
  for (const glyph of glyphs) {
    if (typeof glyph === 'number') {
      advance -= (font?.vertical ? -glyph : glyph) * (size / 1000);
      continue;
    }
    const spacing = state.charSpacing + (glyph?.isSpace ? state.wordSpacing : 0);
    if (font?.vertical) {
      const vmetric = glyph?.vmetric ?? font.defaultVMetrics;
      // Spacing works against the downward advance, as in the renderer.
      advance += (vmetric ? -vmetric[0] : (glyph?.width ?? 0)) * scale - spacing;
    } else advance += (glyph?.width ?? 0) * scale + spacing;
  }
  if (font?.vertical) {
    text.y -= advance;
    return pdfextractBox(
      m,
      startX - 0.5 * em,
      Math.min(startY, text.y) + state.rise,
      startX + 0.5 * em,
      Math.max(startY, text.y) + state.rise,
      0,
    );
  }
  text.x += advance * state.hScale;
  const bottom = startY + state.rise - 0.2 * em,
    top = startY + state.rise + 0.8 * em;
  return pdfextractBox(m, Math.min(startX, text.x), bottom, Math.max(startX, text.x), top, 0);
}
// Subpaths of a constructPath buffer as PDF-space points; curves keep only their end point.
/**
 * @param {Matrix} m
 * @param {ArrayLike<number> | null} path
 * @returns {Subpath[] | undefined}
 */
function pdfextractSubpaths(m, path) {
  if (!path) return;
  /** @type {(x: number, y: number) => [number, number]} */
  const point = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  /** @type {Subpath[]} */
  const subpaths = [];
  /** @type {Subpath | undefined} */
  let current;
  for (let i = 0; i < path.length; ) {
    const op = path[i];
    if (op === DrawOPS.moveTo) {
      current = { points: [point(path[i + 1], path[i + 2])], curved: false, closed: false };
      subpaths.push(current);
      i += 3;
    } else if (op === DrawOPS.lineTo) {
      current?.points.push(point(path[i + 1], path[i + 2]));
      i += 3;
    } else if (op === DrawOPS.curveTo) {
      if (current) {
        current.curved = true;
        current.points.push(point(path[i + 5], path[i + 6]));
      }
      i += 7;
    } else if (op === DrawOPS.closePath) {
      if (current) current.closed = true;
      i += 1;
    } else return;
  }
  return subpaths;
}
/** @type {BoxTuple} */
const PDFEXTRACT_UNBOUNDED = [-Infinity, -Infinity, Infinity, Infinity];
/**
 * Intersection of two boxes (either may be null), or null when they do not overlap.
 * @param {BoxTuple | null} a
 * @param {BoxTuple | null} b
 * @returns {BoxTuple | null}
 */
function pdfextractIntersect(a, b) {
  if (!a || !b) return null;
  /** @type {BoxTuple} */
  const box = [
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
    Math.min(a[2], b[2]),
    Math.min(a[3], b[3]),
  ];
  return box[0] <= box[2] && box[1] <= box[3] ? box : null;
}
/**
 * Whether box `outer` contains box `inner`, allowing `tolerance` on every side.
 * @param {BoxTuple | null} outer
 * @param {BoxTuple} inner
 * @param {number} tolerance
 */
function pdfextractContains(outer, inner, tolerance) {
  return (
    !!outer &&
    inner[0] >= outer[0] - tolerance &&
    inner[1] >= outer[1] - tolerance &&
    inner[2] <= outer[2] + tolerance &&
    inner[3] <= outer[3] + tolerance
  );
}
/**
 * Whether a matrix keeps axis-aligned rectangles axis-aligned (no rotation other than by
 * quarter turns, no skew).
 * @param {Matrix} m
 */
function pdfextractAxisAligned(m) {
  const tiny = (/** @type {number} */ v) => Math.abs(v) < 1e-9;
  return (tiny(m[1]) && tiny(m[2])) || (tiny(m[0]) && tiny(m[3]));
}
/**
 * Whether subpaths form a single axis-aligned rectangle, so its bounds are the exact area.
 * @param {Subpath[] | undefined} subpaths
 */
function pdfextractRectangle(subpaths) {
  if (subpaths?.length !== 1) return false;
  const [{ points, curved }] = subpaths;
  if (curved || points.length < 4 || points.length > 5) return false;
  const near = (/** @type {number} */ a, /** @type {number} */ b) => Math.abs(a - b) <= 0.01,
    xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1]),
    left = Math.min(...xs),
    right = Math.max(...xs),
    bottom = Math.min(...ys),
    top = Math.max(...ys);
  // Every point is a corner, all four corners appear, and consecutive points share an edge.
  const corners = new Set();
  for (const [x, y] of points) {
    if (!(near(x, left) || near(x, right)) || !(near(y, bottom) || near(y, top))) return false;
    corners.add(`${near(x, left)},${near(y, bottom)}`);
  }
  return (
    corners.size === 4 &&
    points.every(([x, y], i) => {
      const [nx, ny] = points[(i + 1) % points.length];
      return near(x, nx) || near(y, ny);
    })
  );
}
/**
 * Whether two boxes share more than a hairline area.
 * @param {BoxTuple} a
 * @param {BoxTuple} b
 */
function pdfextractOverlap(a, b) {
  return (
    Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > 0.01 &&
    Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > 0.01
  );
}
/**
 * Box [x0, y0, x1, y1] of a rectangle mapped by m, grown by pad on every side.
 * @param {Matrix} m
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 * @param {number} pad
 * @returns {BoxTuple}
 */
function pdfextractBox(m, x0, y0, x1, y1, pad) {
  /** @type {number[]} */
  const xs = [],
    ys = [];
  for (const [x, y] of [
    [x0 - pad, y0 - pad],
    [x1 + pad, y0 - pad],
    [x0 - pad, y1 + pad],
    [x1 + pad, y1 + pad],
  ]) {
    xs.push(m[0] * x + m[2] * y + m[4]);
    ys.push(m[1] * x + m[3] * y + m[5]);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
const pdfextractStrokes = new Set([
  OPS.stroke,
  OPS.closeStroke,
  OPS.fillStroke,
  OPS.eoFillStroke,
  OPS.closeFillStroke,
  OPS.closeEOFillStroke,
]);
const pdfextractFills = new Set([
  OPS.fill,
  OPS.eoFill,
  OPS.fillStroke,
  OPS.eoFillStroke,
  OPS.closeFillStroke,
  OPS.closeEOFillStroke,
]);

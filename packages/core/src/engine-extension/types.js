// @ts-check
/* The engine extension: scripts/build.mjs appends these files, in the order of PARTS there, to
 * the exact PDF.js worker, after an import of the bundled PNG encoder (pdfextractEncodePng).
 * They are plain scripts sharing one scope, as they do once appended. All engine names are
 * private to that pinned worker; no engine types cross the API. Type-checked with
 * packages/core/tsconfig.engine.json against types/engine-internals.d.ts. */
// Shared JSDoc types of the engine extension.

/** @typedef {number[]} Matrix An affine matrix [a, b, c, d, e, f]. */
/** @typedef {[number, number, number, number]} BoxTuple A box [x0, y0, x1, y1] in PDF space. */
/** @typedef {{ points: [number, number][]; curved: boolean; closed: boolean }} Subpath */
/**
 * @typedef {object} WalkState Graphics and text state saved by `save` and form XObjects.
 * @property {Matrix} matrix
 * @property {number[]} fill RGB 0..255
 * @property {number[]} stroke RGB 0..255
 * @property {boolean} fillPattern
 * @property {boolean} strokePattern
 * @property {BoxTuple | null} clip Bounds of the clip path; null when everything is clipped away.
 * @property {boolean} clipped Whether any clip is in effect.
 * @property {boolean} clipExact Whether `clip` is the exact clip area: every clip so far was an
 *   axis-aligned rectangle.
 * @property {boolean} unsupported
 * @property {string} variant
 * @property {number} lineWidth
 * @property {number} font Font size.
 * @property {string | undefined} fontName Loaded name of the current font.
 * @property {number} charSpacing
 * @property {number} wordSpacing
 * @property {number} hScale
 * @property {number} leading
 * @property {number} rise
 * @property {number} textMode
 */
/**
 * @typedef {object} PathEvent
 * @property {number} op The paint operator.
 * @property {boolean} stroke
 * @property {boolean} fill
 * @property {Subpath[] | undefined} subpaths PDF-space points; undefined when unparseable.
 * @property {BoxTuple | null} box
 * @property {number} width PDF-space stroke width.
 */
/** @typedef {{ box: BoxTuple | null }} AreaEvent Shown text or a shading fill. */
/** @typedef {{ index: number; box: BoxTuple | null }} ImageEvent An image draw (operator 1001). */
/**
 * @typedef {object} Collector Handlers return true to stop the walk.
 * @property {(event: PathEvent, state: WalkState) => boolean | void} [path]
 * @property {(event: AreaEvent, state: WalkState) => boolean | void} [text]
 * @property {(event: AreaEvent, state: WalkState) => boolean | void} [shading]
 * @property {(event: ImageEvent, state: WalkState) => boolean | void} [image]
 */
/**
 * @typedef {object} ScanRequest
 * @property {number} pageIndex
 * @property {('images' | 'overlay' | 'rules')[]} [collect]
 * @property {string} [decodeId]
 * @property {number} [maxPixels]
 * @property {number} [maxBytes]
 * @property {boolean} [encode]
 * @property {number} [maxWidth]
 * @property {number} [maxHeight]
 * @property {number[]} [orient]
 */
/** @typedef {import('../engine-types.js').RawImage} RawImage */
/** @typedef {import('../engine-types.js').PageRules} PageRules */
/** @typedef {PageRules['rules'][number]} RuleLine */
/** @typedef {Omit<RawImage, 'overlaid'> & { index: number; stencil: boolean; fill: number[] }} ImageInfo */
/**
 * Metrics of a loaded font that place its glyphs: `matrix` maps glyph widths to text space
 * (1/1000 em for most fonts, other units for Type3 and some CFF fonts), and vertical fonts
 * advance downwards using `defaultVMetrics` [w1y, vx, vy] unless a glyph has its own.
 * @typedef {{ matrix: number[]; vertical: boolean; defaultVMetrics: number[] | undefined }} FontMetrics
 */
/**
 * An image draw recorded while building the operator list: PDF.js's buildPaintImageXObject
 * arguments plus the evaluator that built it.
 * @typedef {{ image: any; resources: any; isInline: boolean; localColorSpaceCache: any; evaluator: any }} ImageItem
 */

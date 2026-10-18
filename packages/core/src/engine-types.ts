// Shapes of the worker scan results, shared by engine.ts and the engine extension (via JSDoc).
// Kept free of imports so the extension's separate type check can load it.

/** One image draw reported by the worker scan; geometry is in PDF space. */
export interface RawImage {
  id: string;
  width: number;
  height: number;
  bitsPerComponent: number;
  colorSpace: string;
  hasAlpha: boolean;
  /** Current transformation matrix of the draw (the image's unit square to PDF space). */
  matrix: number[];
  clipped: boolean;
  unsupported: boolean;
  /** Earlier draws on the page with the same matrix and raster size. */
  stack: number;
  /** Whether a later visible paint on the page intersects the draw. */
  overlaid: boolean;
}
/** Axis-aligned ruling lines of a page in PDF space; `truncated` when the line cap was hit. */
export interface PageRules {
  rules: { x1: number; y1: number; x2: number; y2: number; width: number }[];
  truncated: boolean;
}

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
  /** `fill` marks an edge of a shaded area (a cell background) rather than a drawn line. */
  rules: { x1: number; y1: number; x2: number; y2: number; width: number; fill?: boolean }[];
  truncated: boolean;
}
/** Fonts a page's content loaded, by the loaded name text content items refer to. */
export type PageFonts = Record<string, { name: string; bold: boolean }>;
/**
 * Positioned glyphs of a page's upright horizontal text in PDF space (y up), in drawing order:
 * Unicode text (PDF.js), character code, loaded font name, baseline origin x0/y, advance end x1
 * and size, `hidden` for invisible text (a scan's OCR layer); with each font's name and PDF.js
 * ascent/descent (em, possibly NaN).
 */
export interface PageGlyphs {
  glyphs: {
    text: string;
    code: number;
    font: string;
    x0: number;
    x1: number;
    y: number;
    size: number;
    hidden?: boolean;
  }[];
  fonts: Record<string, { name: string; ascent: number; descent: number }>;
  /** Ruling lines of the page, including rules drawn as 1×1 image masks (PDF space). */
  rules: PageRules['rules'];
}

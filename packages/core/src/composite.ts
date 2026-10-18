import type {
  EmbeddedImage,
  ExtractImageOptions,
  ImageOccurrence,
  PdfLimits,
} from './contracts.js';
import { createCanvas, type Engine } from './engine.js';
import { checkAbort, PdfExtractError } from './errors.js';
import { invert, multiply, orientationTransform } from './geometry.js';
import type { Placement } from './inventory.js';

// Composite renders stay within what every supported browser canvas can allocate
// (WebKit caps a canvas at 16,777,216 pixels).
const MAX_CANVAS_PIXELS = 16_777_216;
const MAX_CANVAS_SIDE = 32_767;
// PDF.js text rendering modes: the add-to-clip flag, and clip only without painting (7).
const TEXT_ADD_TO_PATH = 4;
const TEXT_CLIP_ONLY = 7;

/**
 * Render an occurrence's area at its raster resolution (times `scale`) with everything drawn
 * from the image upwards, and encode it as PNG. Operators painting below it are skipped while
 * state operators (transforms, clipping, graphics state) still run.
 */
export async function renderComposite(
  engine: Engine,
  limits: Required<PdfLimits>,
  asset: EmbeddedImage,
  occurrence: ImageOccurrence,
  placement: Placement,
  options: ExtractImageOptions,
  annotations: boolean,
  signal: AbortSignal,
) {
  const scale = options.scale ?? 1,
    orientation = options.preserveOrientation
      ? { rotation: 0 as const, mirrored: false }
      : occurrence.originalOrientation,
    quarterTurn = orientation.rotation % 180 === 90,
    width = Math.max(1, Math.round((quarterTurn ? asset.height : asset.width) * scale)),
    height = Math.max(1, Math.round((quarterTurn ? asset.width : asset.height) * scale)),
    pixelBudget = Math.min(limits.maxImagePixels, MAX_CANVAS_PIXELS);
  if (asset.width * asset.height > limits.maxImagePixels)
    throw new PdfExtractError('RESOURCE_LIMIT_EXCEEDED', 'Image exceeds maxImagePixels', {
      context: { imageId: asset.id },
    });
  if (
    width * height > pixelBudget ||
    Math.max(width, height) > MAX_CANVAS_SIDE ||
    width * height * 16 > limits.maxDecodedBytes
  )
    throw new PdfExtractError(
      'RESOURCE_LIMIT_EXCEEDED',
      `Composite of ${width}×${height} pixels exceeds the rendering budget (${pixelBudget} pixels, ${MAX_CANVAS_SIDE} per side, maxDecodedBytes)`,
      { context: { imageId: asset.id } },
    );
  const page = await engine.doc.getPage(occurrence.pageNumber),
    viewport = page.getViewport({ scale: 1 }),
    rasterToPage = multiply(
      occurrence.imageToPage,
      invert(orientationTransform(orientation, asset.width, asset.height)),
    ),
    transform = multiply(
      multiply([scale, 0, 0, scale, 0, 0], invert(rasterToPage)),
      viewport.transform,
    ),
    // The image's own draw has this canvas transform: PDF.js paints images on a unit square.
    expected = multiply(transform, placement.matrix),
    { OPS, AnnotationMode } = engine;
  const images = new Set(
      [
        'paintImageXObject',
        'paintInlineImageXObject',
        'paintImageMaskXObject',
        'paintSolidColorImageMask',
        'paintImageXObjectRepeat',
        'paintImageMaskXObjectRepeat',
        'paintImageMaskXObjectGroup',
        'paintInlineImageXObjectGroup',
      ].map((name) => OPS[name]),
    ),
    texts = new Set(
      ['showText', 'showSpacedText', 'nextLineShowText', 'nextLineSetSpacingShowText'].map(
        (name) => OPS[name],
      ),
    );
  // Raster size of an image paint operator, or undefined for merged repeat/group operators.
  // biome-ignore lint/suspicious/noExplicitAny: PDF.js operator arguments.
  const rasterSize = (fn: number, args: any[]): [number, number] | undefined => {
    if (fn === OPS.paintImageXObject) return [args[1], args[2]];
    if (fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject)
      return [args[0]?.width, args[0]?.height];
    if (fn === OPS.paintSolidColorImageMask) return [1, 1];
  };
  // Pass the transform through the viewport: PDF.js derives its output scale from
  // render({ transform })[0], which is 0 for quarter-turn placements.
  const renderViewport = Object.assign(Object.create(Object.getPrototypeOf(viewport)), viewport, {
    transform,
    width,
    height,
    scale: Math.sqrt(Math.abs(transform[0] * transform[3] - transform[1] * transform[2])),
  });
  const render = async (isolate: boolean) => {
    let found = false,
      seen = 0;
    // biome-ignore lint/suspicious/noExplicitAny: PDF.js canvas graphics instance.
    const filter = (fn: number, args: any[], gfx: any) => {
      if (found) return false;
      if (images.has(fn)) {
        // Count only draws with this placement and raster size, as the scan does for `stack`.
        const size = rasterSize(fn, args);
        if (!size || size[0] !== asset.width || size[1] !== asset.height) return true;
        const m = gfx.ctx.getTransform(),
          actual = [m.a, m.b, m.c, m.d, m.e, m.f];
        const same = actual.every((v, k) =>
          k < 4
            ? Math.abs(v - expected[k]) <= 1e-3 * Math.max(1, Math.abs(expected[k]))
            : Math.abs(v - expected[k]) <= 0.5,
        );
        if (same && seen++ === placement.stack) {
          found = true;
          return false;
        }
        return true;
      }
      if (fn === OPS.constructPath) {
        // Keep a skipped path's clipping effect: end it without painting.
        if (args[0] !== OPS.endPath) gfx.constructPath(OPS.endPath, args[1], args[2]);
        return args[0] !== OPS.endPath;
      }
      if (texts.has(fn) && gfx.current.textRenderingMode & TEXT_ADD_TO_PATH) {
        // Keep a skipped text's clipping effect: show it invisibly, adding it to the clip.
        const mode = gfx.current.textRenderingMode;
        gfx.current.textRenderingMode = TEXT_CLIP_ONLY;
        try {
          gfx[fn](...args);
        } finally {
          gfx.current.textRenderingMode = mode;
        }
        return true;
      }
      return texts.has(fn) || fn === OPS.shadingFill;
    };
    let surface: ReturnType<typeof createCanvas>;
    try {
      surface = createCanvas(width, height);
    } catch (error) {
      // Node renders with the optional @napi-rs/canvas peer dependency.
      if (error instanceof PdfExtractError && error.code === 'OCR_ASSET_UNAVAILABLE')
        throw new PdfExtractError(
          'UNSUPPORTED_IMAGE_FEATURE',
          'Composite image export in Node needs the optional peer dependency @napi-rs/canvas; install it with `npm install @napi-rs/canvas`',
          { cause: error, context: { imageId: asset.id } },
        );
      throw error;
    }
    const { canvas, context } = surface;
    if (isolate) context.pdfextractFilter = filter;
    const task = page.render({
      canvasContext: context,
      viewport: renderViewport,
      background: 'rgba(0,0,0,0)',
      annotationMode: annotations ? AnnotationMode.ENABLE : AnnotationMode.DISABLE,
    });
    const cancel = () => task.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      await task.promise;
      const pixels = new Uint8Array(context.getImageData(0, 0, width, height).data);
      return { pixels, found };
    } finally {
      signal.removeEventListener('abort', cancel);
      canvas.width = 0;
      canvas.height = 0;
    }
  };
  let composited: 'above' | 'page' = 'above';
  // Render leniently, as viewers do: a content error elsewhere on the page must not cut the
  // render short.
  const result = await engine.renderLeniently(occurrence.pageNumber - 1, async () => {
    try {
      let rendered = await render(true);
      checkAbort(signal);
      if (!rendered.found) {
        // The draw could not be matched (e.g. inside a transparency group or a merged
        // repeated-image operator): render everything within the area instead.
        rendered = await render(false);
        composited = 'page';
        checkAbort(signal);
      }
      return rendered;
    } finally {
      page.cleanup();
    }
  });
  const encoded = await engine.encode(
    result.pixels,
    width,
    height,
    options.maxWidth,
    options.maxHeight,
  );
  return { ...encoded, composited };
}

import type {
  AffineTransform,
  Box,
  EmbeddedImage,
  ExtractionWarning,
  ImageOccurrence,
  OcrProvider,
  OcrRaster,
  OcrResult,
  PdfLimits,
  StructuredTextOptions,
  TextPage,
  TextSpan,
} from './contracts.js';
import { createCanvas, type Page } from './engine.js';
import { checkAbort, collectOrThrow, PdfExtractError } from './errors.js';
import { duplicate, invert, multiply, orientationTransform, transformBox } from './geometry.js';

/** Everything OCR of one page needs. */
export interface RecognitionContext {
  page: Page;
  viewport: { width: number; height: number };
  pageNumber: number;
  /** auto recognizes the page's image occurrences; always recognizes the rendered page. */
  mode: 'auto' | 'always';
  /** The page's lettering is drawn as vector shapes: auto recognizes the rendered page too. */
  outlined: boolean;
  /** Words with a provider confidence below this are dropped. */
  minConfidence: number;
  provider: OcrProvider;
  /** The document's image inventory (used in auto mode). */
  images: readonly EmbeddedImage[];
  /** Native spans of the page; OCR words they already contain are dropped. */
  native: readonly TextSpan[];
  limits: Required<PdfLimits>;
  options: StructuredTextOptions;
  signal: AbortSignal;
  /** Runs a render of this page leniently (see Engine.renderLeniently). */
  renderLeniently<T>(render: () => Promise<T>): Promise<T>;
  /** Decode an occurrence's raster upright, as the placement shows it, enlarged by `scale`. */
  raster(image: EmbeddedImage, occurrence: ImageOccurrence, scale: number): Promise<OcrRaster>;
}
/** Resolution OCR working rasters aim for; Tesseract-class recognizers read best near 300 DPI. */
const OCR_TARGET_DPI = 300;
/** Image regions below this effective resolution are enlarged toward the target first. */
const OCR_UPSCALE_BELOW_DPI = 200;
const OCR_MAX_UPSCALE = 4;
/** Pixels an enlarged raster may reach (8.5 × 11 in at 300 DPI is 8.4 million). */
const OCR_UPSCALE_MAX_PIXELS = 9_000_000;
/** Longest side of real paper in points (17 in, tabloid); larger pages are not physical. */
const PAPER_MAX = 17 * 72;
/** Enlargement for an image region of `pixels` native pixels shown at `dpi`, within budgets. */
function upscale(dpi: number, pixels: number, limits: Required<PdfLimits>) {
  if (!(dpi > 0) || dpi >= OCR_UPSCALE_BELOW_DPI) return 1;
  const factor = Math.min(
    OCR_TARGET_DPI / dpi,
    OCR_MAX_UPSCALE,
    // Enlarged no further than a letter page at 300 DPI: more pixels cost recognition time
    // without reading better.
    Math.sqrt(Math.min(limits.maxOcrPixels, OCR_UPSCALE_MAX_PIXELS) / pixels),
    // The enlarged copy joins the decode working set, estimated at 16 bytes per native pixel.
    Math.sqrt(Math.max(0, limits.maxDecodedBytes - pixels * 16) / (pixels * 4)),
  );
  return factor >= 1.25 ? factor : 1;
}
/**
 * An image that native text covers by 30% or more of its area: a background, watermark or
 * scan under its own text layer. Its text is already there; recognizing it would only add the
 * watermark's lettering, which can bridge a column gutter. Figures with native labels are
 * covered far less.
 */
function behindText(area: Box, native: readonly TextSpan[]) {
  const size = area.width * area.height;
  if (!(size > 0)) return false;
  let covered = 0;
  for (const span of native) {
    const { bbox } = span;
    const w = Math.min(area.x + area.width, bbox.x + bbox.width) - Math.max(area.x, bbox.x),
      h = Math.min(area.y + area.height, bbox.y + bbox.height) - Math.max(area.y, bbox.y);
    if (w > 0 && h > 0 && span.text.trim()) covered += w * h;
  }
  return covered >= size * 0.3;
}
/**
 * An image too small to hold a letter: under 4 pixels or shown under 3 pt in either direction
 * (rules and bars drawn as 1×1 masks, dots, spacers). A page of TeX math may draw thousands.
 */
function tiny(image: EmbeddedImage, { bbox }: ImageOccurrence) {
  return image.width < 4 || image.height < 4 || bbox.width < 3 || bbox.height < 3;
}
/** Text layers this many words long or longer are judged by how cleanly they read. */
const LAYER_WORDS = 20;
/**
 * Share of a text's words that read as words, numbers or codes rather than recognition debris
 * (`0Ql.5)')81`, `Cot)'I"JCCll`): letters with at most inner apostrophes or hyphens, figures with
 * their marks, or letters then digits (`DQ453581`), once outer punctuation is stripped.
 */
export function cleanShare(words: readonly string[]) {
  return clean(words).share;
}
/** Words counted (two characters or more) and the clean share of them. */
function clean(words: readonly string[]) {
  let counted = 0,
    clean = 0;
  for (const raw of words) {
    const word = raw.replace(/^[\s"'“”‘’([{<*•·]+|[\s"'“”‘’)\]}>.,;:!?*]+$/gu, '');
    if (word.length < 2) continue;
    counted++;
    if (
      /^\p{L}+(?:['’-]\p{L}+)*$/u.test(word) ||
      /^[$€£#+-]?\d[\d.,:/%-]*$/u.test(word) ||
      /^\p{Lu}+\d+$/u.test(word)
    )
      clean++;
  }
  return { counted, share: counted ? clean / counted : 0 };
}
/**
 * The native text over `area` (spans whose centre lies in it): its words, and the share of the
 * area's height its lines cover, which tells a text layer over a whole scan from a stamp.
 */
function layerText(area: Box, native: readonly TextSpan[]) {
  const inside = native.filter((s) => {
    const x = s.bbox.x + s.bbox.width / 2,
      y = s.bbox.y + s.bbox.height / 2;
    return (
      s.text.trim() &&
      x >= area.x &&
      x <= area.x + area.width &&
      y >= area.y &&
      y <= area.y + area.height
    );
  });
  let covered = 0,
    end = Number.NEGATIVE_INFINITY;
  for (const { bbox } of [...inside].sort((a, b) => a.bbox.y - b.bbox.y)) {
    covered += Math.max(0, bbox.y + bbox.height - Math.max(bbox.y, end));
    end = Math.max(end, bbox.y + bbox.height);
  }
  return {
    words: inside.flatMap((s) => s.text.split(/\s+/).filter(Boolean)),
    spread: covered / Math.max(area.height, 1e-9),
  };
}
/** Whether a recognition found any word. */
const words = (recognized: OcrResult) => recognized.lines.some((l) => l.words.length);
/** OCR outcome of a page: new spans, diagnostics and coverage status. */
export interface Recognition {
  spans: TextSpan[];
  /** Words the provider recognized as one line share a key, so layout keeps that line. */
  lines: WeakMap<TextSpan, object>;
  warnings: ExtractionWarning[];
  status: TextPage['ocrStatus'];
  /** Native spans of a poor text layer that recognition replaced: leave them out. */
  replaced: Set<TextSpan>;
}

/**
 * Recognize a page task by task. A failed task fails the operation, or with errorMode collect
 * becomes a warning and a partial or failed status that later successes cannot hide.
 */
export async function recognizePage(ctx: RecognitionContext): Promise<Recognition> {
  const { pageNumber, options, signal } = ctx;
  // A scan under its own text layer (an earlier recognition, often invisible text) needs no
  // recognition when the layer reads cleanly; a poor one is recognized again, and replaced
  // where the new words read clearly better.
  const layer = (o: ImageOccurrence) => {
    const { words, spread } = layerText(o.bbox, ctx.native),
      { counted, share } = clean(words);
    return { words: counted, clean: share, spread };
  };
  const tasks: {
    image?: EmbeddedImage;
    occurrence?: ImageOccurrence;
    layer?: ReturnType<typeof layer>;
  }[] =
    ctx.mode === 'always' || ctx.outlined
      ? [{}]
      : ctx.images.flatMap((image) =>
          image.occurrences.flatMap((occurrence) => {
            if (occurrence.pageNumber !== pageNumber || tiny(image, occurrence)) return [];
            // Only a scan (an image over half the page or more) is judged by its layer, one whose
            // lines run down a fifth of it or more: native labels over a smaller figure do not hold
            // the figure's own lettering, nor does a citation stamped at a scan's foot.
            const text = layer(occurrence),
              judged =
                text.words >= LAYER_WORDS &&
                text.spread >= 0.2 &&
                occurrence.bbox.width * occurrence.bbox.height >=
                  ctx.viewport.width * ctx.viewport.height * 0.5;
            if (judged ? text.clean >= 0.85 : behindText(occurrence.bbox, ctx.native)) return [];
            return [{ image, occurrence, ...(judged ? { layer: text } : {}) }];
          }),
        );
  const result: Recognition = {
    spans: [],
    lines: new WeakMap(),
    warnings: [],
    status: 'not-needed',
    replaced: new Set(),
  };
  /** Adds a recognition's words that clear the confidence floor and native text lacks. */
  const collect = (
    recognized: OcrResult,
    transform: AffineTransform,
    task: { image?: EmbeddedImage; occurrence?: ImageOccurrence; layer?: ReturnType<typeof layer> },
  ) => {
    // A poor text layer whose recognition reads clearly cleaner gives way to it.
    const words = recognized.lines.flatMap((l) =>
      l.words.filter((w) => w.confidence === undefined || w.confidence >= ctx.minConfidence),
    );
    const replace =
      !!task.layer &&
      !!task.occurrence &&
      words.length >= task.layer.words * 0.5 &&
      cleanShare(words.map((w) => w.text)) >= task.layer.clean + 0.1;
    if (replace && task.occurrence) {
      const area = task.occurrence.bbox;
      for (const span of ctx.native) {
        const x = span.bbox.x + span.bbox.width / 2,
          y = span.bbox.y + span.bbox.height / 2;
        if (x >= area.x && x <= area.x + area.width && y >= area.y && y <= area.y + area.height)
          result.replaced.add(span);
      }
    }
    // Word boxes hug their glyphs, so a word without ascenders sits lower than its neighbours.
    // Like native spans, words of an upright line take the line's top and bottom, so rows
    // (in layout and table detection) do not split at short words.
    const upright = transform[1] === 0 && transform[2] === 0;
    for (const line of recognized.lines) {
      const key = {},
        words = line.words.map((word) => ({ word, bbox: transformBox(word.bbox, transform) }));
      const top = Math.min(...words.map((w) => w.bbox.y)),
        bottom = Math.max(...words.map((w) => w.bbox.y + w.bbox.height));
      for (const { word, bbox } of words) {
        if (word.confidence !== undefined && word.confidence < ctx.minConfidence) continue;
        const span: TextSpan = {
          text: word.text,
          bbox: upright ? { ...bbox, y: top, height: bottom - top } : bbox,
          source: 'ocr',
          confidence: word.confidence,
          ...(task.image ? { imageId: task.image.id } : {}),
        };
        if (!replace && duplicate(span, ctx.native)) continue;
        result.spans.push(span);
        result.lines.set(span, key);
      }
    }
    result.warnings.push(...recognized.warnings);
  };
  const oversized = Math.max(ctx.viewport.width, ctx.viewport.height) > PAPER_MAX;
  const run = { signal, onProgress: options.onProgress };
  const fail = (error: unknown, task: { image?: EmbeddedImage }) => {
    result.warnings.push(
      collectOrThrow(error, options.errorMode, signal, 'OCR_FAILED', 'OCR region failed', {
        pageNumber,
        imageId: task.image?.id,
      }),
    );
    result.status = result.spans.length || result.status === 'performed' ? 'partial' : 'failed';
  };
  for (const [taskIndex, task] of tasks.entries()) {
    checkAbort(signal);
    try {
      let { raster, transform } =
        task.image && task.occurrence
          ? await imageTask(ctx, task.image, task.occurrence)
          : await pageTask(ctx);
      let recognized = await ctx.provider.recognize(raster, run);
      // On a page larger than any paper (over 17 in, as image-to-PDF tools make by placing scans
      // at 72 or 96 DPI) the geometry's resolution can be far off. When it finds no words, the
      // image is read again as it is, the recognizer estimating its resolution.
      if (task.image && task.occurrence && !words(recognized) && oversized) {
        ({ raster, transform } = await imageTask(ctx, task.image, task.occurrence, false));
        recognized = await ctx.provider.recognize(raster, run);
      }
      collect(recognized, transform, task);
      result.status = ['partial', 'failed'].includes(result.status) ? 'partial' : 'performed';
      options.onProgress?.({
        stage: 'ocr',
        completed: taskIndex + 1,
        total: tasks.length,
        unit: 'tasks',
        pageNumber,
      });
    } catch (error) {
      fail(error, task);
    }
  }
  // A page with no text at all (handwriting, forms, faint scans) after the reads above: its
  // images are read once more as scattered words. Pages with text never are, where a sparse
  // read of a figure would only add noise.
  if (
    !result.spans.length &&
    !ctx.native.some((s) => s.text.trim()) &&
    result.status === 'performed'
  )
    for (const task of tasks) {
      if (!task.image || !task.occurrence) continue;
      checkAbort(signal);
      try {
        const { raster, transform } = await imageTask(ctx, task.image, task.occurrence, !oversized);
        raster.layout = 'sparse';
        collect(await ctx.provider.recognize(raster, run), transform, task);
      } catch (error) {
        fail(error, task);
      }
    }
  return result;
}
/**
 * An image occurrence's upright raster and its raster-to-page transform. An image larger than
 * maxOcrPixels is reduced to fit it (as a page render is); a placement shown below 200 DPI is
 * enlarged toward 300 DPI within the budgets. The raster reports its effective DPI.
 */
async function imageTask(
  ctx: RecognitionContext,
  image: EmbeddedImage,
  occurrence: ImageOccurrence,
  geometry = true,
) {
  const { width, height } = image,
    pixels = width * height;
  // Effective resolution of the placement: points per raster pixel → DPI; without `geometry`
  // unknown, so the image is not enlarged and the recognizer estimates it.
  const [a, b, c, d] = occurrence.imageToPage,
    dpi = geometry ? 72 / Math.sqrt(Math.abs(a * d - b * c)) : Number.NaN;
  const scale =
    pixels > ctx.limits.maxOcrPixels
      ? Math.sqrt(ctx.limits.maxOcrPixels / pixels)
      : upscale(dpi, pixels, ctx.limits);
  // Recognize upright text: OCR the raster as the placement shows it on the page.
  const raster = await ctx.raster(image, occurrence, scale);
  checkAbort(ctx.signal);
  const quarterTurn = occurrence.originalOrientation.rotation % 180 === 90,
    fx = raster.width / (quarterTurn ? height : width),
    fy = raster.height / (quarterTurn ? width : height);
  if (Number.isFinite(dpi)) raster.dpi = dpi * Math.sqrt(fx * fy);
  const transform: AffineTransform = multiply(
    multiply(
      occurrence.imageToPage,
      invert(orientationTransform(occurrence.originalOrientation, width, height)),
    ),
    [1 / fx, 0, 0, 1 / fy, 0, 0],
  );
  return { raster, transform };
}
/** The page rendered at up to 300 DPI within the OCR pixel budget, and its raster-to-page transform. */
async function pageTask({ page, viewport, limits, signal, renderLeniently }: RecognitionContext) {
  const scale = Math.min(
    OCR_TARGET_DPI / 72,
    Math.sqrt(limits.maxOcrPixels / (viewport.width * viewport.height)),
  );
  const working = page.getViewport({ scale }),
    width = Math.ceil(working.width),
    height = Math.ceil(working.height);
  if (width * height > limits.maxOcrPixels + width + height)
    throw new PdfExtractError('RESOURCE_LIMIT_EXCEEDED', 'Page exceeds OCR budget');
  const { canvas, context } = createCanvas(width, height);
  const cancel = { run: () => {} };
  const abort = () => cancel.run();
  signal.addEventListener('abort', abort, { once: true });
  try {
    await renderLeniently(async () => {
      const render = page.render({ canvasContext: context, viewport: working });
      cancel.run = () => render.cancel();
      if (signal.aborted) render.cancel();
      await render.promise;
    });
    const raster: OcrRaster = {
      data: new Uint8Array(context.getImageData(0, 0, width, height).data),
      width,
      height,
      stride: width * 4,
      format: 'rgba8',
      dpi: 72 * scale,
    };
    const transform: AffineTransform = [1 / scale, 0, 0, 1 / scale, 0, 0];
    return { raster, transform };
  } finally {
    signal.removeEventListener('abort', abort);
    canvas.width = 0;
    canvas.height = 0;
  }
}

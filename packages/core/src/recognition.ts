import type {
  AffineTransform,
  EmbeddedImage,
  ExtractionWarning,
  ImageOccurrence,
  OcrProvider,
  OcrRaster,
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
  /** Decode an occurrence's raster upright, as the placement shows it. */
  raster(image: EmbeddedImage, occurrence: ImageOccurrence): Promise<OcrRaster>;
}
/** OCR outcome of a page: new spans, diagnostics and coverage status. */
export interface Recognition {
  spans: TextSpan[];
  warnings: ExtractionWarning[];
  status: TextPage['ocrStatus'];
}

/**
 * Recognize a page task by task. A failed task fails the operation, or with errorMode collect
 * becomes a warning and a partial or failed status that later successes cannot hide.
 */
export async function recognizePage(ctx: RecognitionContext): Promise<Recognition> {
  const { pageNumber, options, signal } = ctx;
  const tasks: { image?: EmbeddedImage; occurrence?: ImageOccurrence }[] =
    ctx.mode === 'always'
      ? [{}]
      : ctx.images.flatMap((image) =>
          image.occurrences
            .filter((o) => o.pageNumber === pageNumber)
            .map((occurrence) => ({ image, occurrence })),
        );
  const result: Recognition = { spans: [], warnings: [], status: 'not-needed' };
  for (const [taskIndex, task] of tasks.entries()) {
    checkAbort(signal);
    try {
      const { raster, transform } =
        task.image && task.occurrence
          ? await imageTask(ctx, task.image, task.occurrence)
          : await pageTask(ctx);
      const recognized = await ctx.provider.recognize(raster, {
        signal,
        onProgress: options.onProgress,
      });
      for (const line of recognized.lines)
        for (const word of line.words) {
          const span: TextSpan = {
            text: word.text,
            bbox: transformBox(word.bbox, transform),
            source: 'ocr',
            confidence: word.confidence,
            ...(task.image ? { imageId: task.image.id } : {}),
          };
          if (!duplicate(span, ctx.native)) result.spans.push(span);
        }
      result.warnings.push(...recognized.warnings);
      result.status = ['partial', 'failed'].includes(result.status) ? 'partial' : 'performed';
      options.onProgress?.({
        stage: 'ocr',
        completed: taskIndex + 1,
        total: tasks.length,
        unit: 'tasks',
        pageNumber,
      });
    } catch (error) {
      result.warnings.push(
        collectOrThrow(error, options.errorMode, signal, 'OCR_FAILED', 'OCR region failed', {
          pageNumber,
          imageId: task.image?.id,
        }),
      );
      result.status = result.spans.length || result.status === 'performed' ? 'partial' : 'failed';
    }
  }
  return result;
}
/** An image occurrence's upright raster and its raster-to-page transform. */
async function imageTask(
  ctx: RecognitionContext,
  image: EmbeddedImage,
  occurrence: ImageOccurrence,
) {
  if (image.width * image.height > ctx.limits.maxOcrPixels)
    throw new PdfExtractError('RESOURCE_LIMIT_EXCEEDED', 'Image exceeds maxOcrPixels');
  // Recognize upright text: OCR the raster as the placement shows it on the page.
  const raster = await ctx.raster(image, occurrence);
  checkAbort(ctx.signal);
  const transform: AffineTransform = multiply(
    occurrence.imageToPage,
    invert(orientationTransform(occurrence.originalOrientation, image.width, image.height)),
  );
  return { raster, transform };
}
/** The page rendered within the OCR pixel budget (at most 2×) and its raster-to-page transform. */
async function pageTask({ page, viewport, limits, signal, renderLeniently }: RecognitionContext) {
  const scale = Math.min(2, Math.sqrt(limits.maxOcrPixels / (viewport.width * viewport.height)));
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
    };
    const transform: AffineTransform = [1 / scale, 0, 0, 1 / scale, 0, 0];
    return { raster, transform };
  } finally {
    signal.removeEventListener('abort', abort);
    canvas.width = 0;
    canvas.height = 0;
  }
}

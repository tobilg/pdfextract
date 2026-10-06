import type {
  AffineTransform,
  EmbeddedImage,
  ExtractedImage,
  ExtractImageOptions,
  GetImagesOptions,
  OcrRaster,
  OpenPdfOptions,
  OperationOptions,
  PdfDocument,
  PdfInput,
  PdfLimits,
  StructuredText,
  StructuredTextOptions,
  TextPage,
  TextSpan,
} from './contracts.js';
import { createCanvas, inputBytes, openEngine } from './engine.js';
import { checkAbort, PdfExtractError, positive } from './errors.js';
import { duplicate, layout, multiply, transformBox } from './geometry.js';
/** Default positive resource budgets; decoded memory is estimated and full exports never silently downscale. */
export const DEFAULT_LIMITS: Required<PdfLimits> = Object.freeze({
  maxInputBytes: 256 * 1024 * 1024,
  maxPages: 10000,
  maxImagePixels: 64_000_000,
  maxDecodedBytes: 1024 * 1024 * 1024,
  maxOcrPixels: 16_000_000,
});
/**
 * Open a whole PDF and return a caller-owned document handle.
 *
 * @param input - File/Blob or whole PDF bytes; caller-owned buffers are copied before worker transfer.
 * @param options - Password, assets, resource limits and a borrowed OCR provider.
 * @returns A document to close in a finally block. Closing it never closes the supplied OCR provider.
 * @throws {@link PdfExtractError} for invalid/password-protected input, invalid options, cancellation or resource limits.
 * @example
 * ```ts
 * const pdf = await openPdf(bytes);
 * try {
 *   const text = await pdf.getStructuredText({ ocr: 'off' });
 *   console.log(text.fullText);
 * } finally {
 *   await pdf.close();
 * }
 * ```
 */
export async function openPdf(input: PdfInput, options: OpenPdfOptions = {}): Promise<PdfDocument> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const [k, v] of Object.entries(limits)) positive(v, k);
  checkAbort(options.signal);
  const bytes = await inputBytes(input, limits.maxInputBytes);
  checkAbort(options.signal);
  const byteLength = bytes.length;
  const engine = await openEngine(bytes, options);
  if (engine.doc.numPages > limits.maxPages) {
    await engine.close();
    throw new PdfExtractError('RESOURCE_LIMIT_EXCEEDED', 'Page count exceeds maxPages');
  }
  options.onProgress?.({
    stage: 'open',
    completed: byteLength,
    total: byteLength,
    unit: 'bytes',
  });
  return new Document(engine, options, limits);
}
class Document implements PdfDocument {
  readonly pageCount: number;
  private closed = false;
  private closing?: Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  private controller = new AbortController();
  private inventory?: EmbeddedImage[];
  private locations = new Map<string, { pageIndex: number; rawId: string }>();
  private readonly prefix = crypto.randomUUID();
  constructor(
    private engine: Awaited<ReturnType<typeof openEngine>>,
    private options: OpenPdfOptions,
    private limits: Required<PdfLimits>,
  ) {
    this.pageCount = engine.doc.numPages;
  }
  private queue<T>(
    options: OperationOptions,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new PdfExtractError('DOCUMENT_CLOSED', 'PDF is closed'));
    const signal = options.signal
      ? AbortSignal.any([options.signal, this.controller.signal])
      : this.controller.signal;
    const promise = this.tail.then(async () => {
      checkAbort(signal);
      try {
        const value = await run(signal);
        checkAbort(signal);
        return value;
      } catch (e) {
        checkAbort(signal);
        throw e;
      }
    });
    this.tail = promise.catch(() => {});
    // A decoder may finish its current bounded job in the worker. Cancellation
    // is observable immediately and the serial queue cannot start more work.
    let abort: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () =>
        reject(new PdfExtractError('ABORTED', 'Operation cancelled', { cause: signal.reason }));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    return Promise.race([promise, cancelled]).finally(() =>
      signal.removeEventListener('abort', abort),
    );
  }
  private pages(pages?: readonly number[]) {
    const result = pages
      ? [...new Set(pages)].sort((a, b) => a - b)
      : Array.from({ length: this.pageCount }, (_, i) => i + 1);
    for (const page of result)
      if (!Number.isSafeInteger(page) || page < 1 || page > this.pageCount)
        throw new PdfExtractError('INVALID_ARGUMENT', 'Invalid page number');
    return result;
  }
  private async collectImages(options: OperationOptions, signal: AbortSignal) {
    if (this.inventory) return this.inventory;
    const assets = new Map<string, EmbeddedImage>();
    for (let pageIndex = 0; pageIndex < this.pageCount; pageIndex++) {
      checkAbort(signal);
      const page = await this.engine.doc.getPage(pageIndex + 1);
      const viewport = page.getViewport({ scale: 1 });
      const raw = await this.engine.images(pageIndex);
      for (const [index, item] of raw.entries()) {
        const id = `${this.prefix}-${item.id}`;
        const imageToPage = multiply(multiply(viewport.transform, item.matrix), [
          1 / item.width,
          0,
          0,
          -1 / item.height,
          0,
          1,
        ]);
        let asset = assets.get(id);
        if (!asset) {
          asset = {
            id,
            width: item.width,
            height: item.height,
            bitsPerComponent: item.bitsPerComponent,
            colorSpace: item.colorSpace,
            hasAlpha: item.hasAlpha,
            occurrences: [],
            warnings: item.unsupported
              ? [
                  {
                    code: 'UNSUPPORTED_IMAGE_FEATURE',
                    message: 'Image appearance depends on an unsupported graphics state',
                    imageId: id,
                  },
                ]
              : [],
          };
          assets.set(id, asset);
          this.locations.set(id, { pageIndex, rawId: item.id });
        }
        asset.occurrences.push({
          occurrenceId: `${id}-${pageIndex + 1}-${index}`,
          pageNumber: pageIndex + 1,
          imageToPage,
          bbox: transformBox({ x: 0, y: 0, width: item.width, height: item.height }, imageToPage),
          clipped: item.clipped,
        });
      }
      page.cleanup();
      options.onProgress?.({
        stage: 'images',
        completed: pageIndex + 1,
        total: this.pageCount,
        unit: 'pages',
        pageNumber: pageIndex + 1,
      });
    }
    this.inventory = [...assets.values()];
    return this.inventory;
  }
  getImages(options: GetImagesOptions = {}) {
    return this.queue(options, async (signal) => {
      const pages = this.pages(options.pages);
      const assets = await this.collectImages(options, signal);
      return structuredClone(
        assets
          .map((a) => ({
            ...a,
            occurrences: a.occurrences.filter((o) => pages.includes(o.pageNumber)),
          }))
          .filter((a) => a.occurrences.length),
      );
    });
  }
  private async raster(id: string, signal: AbortSignal) {
    checkAbort(signal);
    const location = this.locations.get(id);
    if (!location)
      throw new PdfExtractError('IMAGE_NOT_FOUND', 'Unknown image ID', {
        context: { imageId: id },
      });
    const raw = await this.engine.images(
      location.pageIndex,
      location.rawId,
      this.limits.maxImagePixels,
      this.limits.maxDecodedBytes,
    );
    checkAbort(signal);
    return {
      data: new Uint8Array(raw.pixels),
      width: raw.width as number,
      height: raw.height as number,
      stride: raw.width * 4,
      format: 'rgba8' as const,
    };
  }
  extractImage(id: string, options: ExtractImageOptions = {}): Promise<ExtractedImage> {
    return this.queue(options, async (signal) => {
      if (options.maxWidth !== undefined) positive(options.maxWidth, 'maxWidth');
      if (options.maxHeight !== undefined) positive(options.maxHeight, 'maxHeight');
      await this.collectImages(options, signal);
      checkAbort(signal);
      const location = this.locations.get(id);
      if (!location)
        throw new PdfExtractError('IMAGE_NOT_FOUND', 'Unknown image ID', {
          context: { imageId: id },
        });
      const source = await this.engine.images(
        location.pageIndex,
        location.rawId,
        this.limits.maxImagePixels,
        this.limits.maxDecodedBytes,
        { encode: true, maxWidth: options.maxWidth, maxHeight: options.maxHeight },
      );
      checkAbort(signal);
      const width = source.width,
        height = source.height,
        data = new Uint8Array(source.encoded);
      options.onProgress?.({
        stage: 'export',
        completed: 1,
        total: 1,
        unit: 'images',
        imageId: id,
      });
      return {
        imageId: id,
        data,
        mimeType: 'image/png',
        width,
        height,
        variant:
          options.maxWidth !== undefined || options.maxHeight !== undefined ? 'thumbnail' : 'full',
      };
    });
  }
  getStructuredText(options: StructuredTextOptions = {}): Promise<StructuredText> {
    return this.queue(options, async (signal) => {
      const provider = this.options.ocr;
      const mode = options.ocr ?? (provider ? 'auto' : 'off');
      if (!['off', 'auto', 'always'].includes(mode))
        throw new PdfExtractError('INVALID_ARGUMENT', 'Invalid OCR mode');
      if (mode !== 'off' && !this.options.ocr)
        throw new PdfExtractError('OCR_PROVIDER_REQUIRED', 'An OCR provider is required');
      if (options.errorMode && !['throw', 'collect'].includes(options.errorMode))
        throw new PdfExtractError('INVALID_ARGUMENT', 'Invalid errorMode');
      const selected = this.pages(options.pages),
        pages: TextPage[] = [];
      const images = mode === 'auto' ? await this.collectImages(options, signal) : [];
      for (const pageNumber of selected) {
        checkAbort(signal);
        const page = await this.engine.doc.getPage(pageNumber),
          viewport = page.getViewport({ scale: 1 });
        const output: TextPage = {
          pageNumber,
          width: viewport.width,
          height: viewport.height,
          rotation: page.rotate,
          fullText: '',
          blocks: [],
          ocrStatus: mode === 'off' ? 'disabled' : 'not-needed',
          warnings: [],
        };
        const native: TextSpan[] = [],
          ocr: TextSpan[] = [];
        try {
          const content = await page.getTextContent();
          for (const item of content.items) {
            if (!item.str) continue;
            const size =
              Math.hypot(item.transform[2], item.transform[3]) ||
              Math.hypot(item.transform[0], item.transform[1]) ||
              1;
            const style = content.styles[item.fontName] ?? {},
              ascent = style.ascent ?? 0.8,
              descent = style.descent ?? -0.2;
            const bbox = transformBox(
              { x: 0, y: descent, width: item.width / size, height: ascent - descent },
              multiply(viewport.transform, item.transform),
            );
            native.push({
              text: item.str,
              bbox,
              quad: (() => {
                const m = multiply(viewport.transform, item.transform);
                return [
                  [0, ascent],
                  [item.width / size, ascent],
                  [item.width / size, descent],
                  [0, descent],
                ].flatMap(([x, y]) => [
                  m[0] * x + m[2] * y + m[4],
                  m[1] * x + m[3] * y + m[5],
                ]) as unknown as import('./contracts.js').Quad;
              })(),
              source: 'native',
              fontName: style.fontFamily ?? item.fontName,
              fontSize: size * page.userUnit,
            });
          }
          if (mode !== 'off' && provider) {
            const tasks: {
              image?: EmbeddedImage;
              occurrence?: EmbeddedImage['occurrences'][number];
            }[] =
              mode === 'always'
                ? [{}]
                : images.flatMap((image) =>
                    image.occurrences
                      .filter((o) => o.pageNumber === pageNumber)
                      .map((occurrence) => ({ image, occurrence })),
                  );
            for (const [taskIndex, task] of tasks.entries()) {
              checkAbort(signal);
              try {
                let raster: OcrRaster;
                let transform: AffineTransform;
                if (task.image && task.occurrence) {
                  if (task.image.width * task.image.height > this.limits.maxOcrPixels)
                    throw new PdfExtractError(
                      'RESOURCE_LIMIT_EXCEEDED',
                      'Image exceeds maxOcrPixels',
                    );
                  raster = await this.raster(task.image.id, signal);
                  transform = task.occurrence.imageToPage;
                } else {
                  const scale = Math.min(
                    2,
                    Math.sqrt(this.limits.maxOcrPixels / (viewport.width * viewport.height)),
                  );
                  const working = page.getViewport({ scale }),
                    width = Math.ceil(working.width),
                    height = Math.ceil(working.height);
                  if (width * height > this.limits.maxOcrPixels + width + height)
                    throw new PdfExtractError('RESOURCE_LIMIT_EXCEEDED', 'Page exceeds OCR budget');
                  const { canvas, context } = createCanvas(width, height);
                  const render = page.render({ canvasContext: context, viewport: working });
                  const cancel = () => render.cancel();
                  signal.addEventListener('abort', cancel, { once: true });
                  try {
                    await render.promise;
                    raster = {
                      data: new Uint8Array(context.getImageData(0, 0, width, height).data),
                      width,
                      height,
                      stride: width * 4,
                      format: 'rgba8' as const,
                    };
                  } finally {
                    signal.removeEventListener('abort', cancel);
                    canvas.width = 0;
                    canvas.height = 0;
                  }
                  transform = [1 / scale, 0, 0, 1 / scale, 0, 0];
                }
                const result = await provider.recognize(raster, {
                  signal,
                  onProgress: options.onProgress,
                });
                for (const line of result.lines)
                  for (const word of line.words) {
                    const span: TextSpan = {
                      text: word.text,
                      bbox: transformBox(word.bbox, transform),
                      source: 'ocr',
                      confidence: word.confidence,
                      ...(task.image ? { imageId: task.image.id } : {}),
                    };
                    if (!duplicate(span, native)) ocr.push(span);
                  }
                output.warnings.push(...result.warnings);
                output.ocrStatus = ['partial', 'failed'].includes(output.ocrStatus)
                  ? 'partial'
                  : 'performed';
                options.onProgress?.({
                  stage: 'ocr',
                  completed: taskIndex + 1,
                  total: tasks.length,
                  unit: 'tasks',
                  pageNumber,
                });
              } catch (error) {
                checkAbort(signal);
                if (options.errorMode !== 'collect')
                  throw error instanceof PdfExtractError
                    ? error
                    : new PdfExtractError('OCR_FAILED', 'OCR region failed', {
                        cause: error,
                        context: { pageNumber, imageId: task.image?.id },
                      });
                output.ocrStatus =
                  ocr.length || output.ocrStatus === 'performed' ? 'partial' : 'failed';
                output.warnings.push({
                  code: error instanceof PdfExtractError ? error.code : 'OCR_FAILED',
                  message: String(error),
                  pageNumber,
                  imageId: task.image?.id,
                });
              }
            }
          }
        } catch (error) {
          checkAbort(signal);
          if (options.errorMode !== 'collect')
            throw error instanceof PdfExtractError
              ? error
              : new PdfExtractError('TEXT_EXTRACTION_FAILED', 'Page text extraction failed', {
                  cause: error,
                  context: { pageNumber },
                });
          output.warnings.push({
            code: 'TEXT_EXTRACTION_FAILED',
            message: String(error),
            pageNumber,
          });
        } finally {
          page.cleanup();
        }
        output.blocks = layout([...native, ...ocr]);
        output.fullText = output.blocks.map((b) => b.text).join('\n\n');
        pages.push(output);
        options.onProgress?.({
          stage: 'text',
          completed: pages.length,
          total: selected.length,
          unit: 'pages',
          pageNumber,
        });
      }
      const warnings = pages.flatMap((p) => p.warnings);
      return {
        schemaVersion: 1,
        status: warnings.length ? 'partial' : 'complete',
        pageCount: this.pageCount,
        pages,
        fullText: pages.map((p) => p.fullText).join('\n\n\f\n\n'),
        warnings,
      };
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.controller.abort();
    this.closing = this.engine.close().finally(() => {
      this.inventory = undefined;
      this.locations.clear();
    });
    return this.closing;
  }
}

import { renderComposite } from './composite.js';
import type {
  EmbeddedImage,
  ExtractedImage,
  ExtractImageOptions,
  GetImagesOptions,
  ImageList,
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
import { type Engine, inputBytes, openEngine, type PageGlyphs } from './engine.js';
import { checkAbort, collectOrThrow, PdfExtractError, positive } from './errors.js';
import { exactExport, uprightRaster } from './export.js';
import { markFurniture, markRepeatedFurniture } from './furniture.js';
import { intersects, layout, point } from './geometry.js';
import { ImageInventory } from './inventory.js';
import { lineNumbers } from './line-numbers.js';
import { isTexPage, spliceMath } from './math.js';
import { type Recognition, recognizePage } from './recognition.js';
import { RuleCache } from './rule-cache.js';
import { markHeadings } from './structure.js';
import { type DetectedTable, pageTables, type Rule } from './tables.js';
import { composeAccents, letterSpaced, nativeSpans, respace } from './text.js';

/** Default positive resource budgets; decoded memory is estimated and full exports never silently downscale. */
export const DEFAULT_LIMITS: Required<PdfLimits> = Object.freeze({
  maxInputBytes: 256 * 1024 * 1024,
  maxPages: 10000,
  maxImagePixels: 64_000_000,
  maxDecodedBytes: 1024 * 1024 * 1024,
  maxOcrPixels: 16_000_000,
  maxCachedRuleLines: 200_000,
});
/**
 * Open a whole PDF and return a caller-owned document handle.
 *
 * @param input - File/Blob or whole PDF bytes; caller-owned buffers are copied before worker transfer.
 * @param options - Password, assets, resource limits, a borrowed OCR provider, and the
 *   `composite`/`annotations` image export defaults (both false).
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
  for (const name of ['composite', 'annotations'] as const)
    if (options[name] !== undefined && typeof options[name] !== 'boolean')
      throw new PdfExtractError('INVALID_ARGUMENT', `Invalid ${name} option`);
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
  /** Ruling lines of pages scanned for table detection. */
  private rules: RuleCache;
  private inventory: ImageInventory;
  constructor(
    private engine: Engine,
    private options: OpenPdfOptions,
    private limits: Required<PdfLimits>,
  ) {
    this.pageCount = engine.doc.numPages;
    this.inventory = new ImageInventory(engine, crypto.randomUUID());
    this.rules = new RuleCache(limits.maxCachedRuleLines);
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
  /** Rejects a defined option that is not a boolean. */
  private static booleans(options: object, names: readonly string[]) {
    for (const name of names) {
      const value = (options as Record<string, unknown>)[name];
      if (value !== undefined && typeof value !== 'boolean')
        throw new PdfExtractError('INVALID_ARGUMENT', `Invalid ${name} option`);
    }
  }
  getImages(options: GetImagesOptions = {}): Promise<ImageList> {
    return this.queue(options, async (signal) => {
      const pages = this.pages(options.pages);
      const minWidth = options.minWidth === undefined ? 0 : positive(options.minWidth, 'minWidth'),
        minHeight = options.minHeight === undefined ? 0 : positive(options.minHeight, 'minHeight');
      Document.booleans(options, ['annotations']);
      const assets = await this.inventory.collect(options, signal, pages);
      const wanted = new Set(pages);
      const selected = assets.filter((a) => a.occurrences.some((o) => wanted.has(o.pageNumber)));
      // Size as exported by default: the first placement's orientation decides, like extractImage.
      const kept = selected.filter((a) => {
        const quarterTurn = a.occurrences[0].originalOrientation.rotation % 180 === 90;
        const width = quarterTurn ? a.height : a.width,
          height = quarterTurn ? a.width : a.height;
        return width >= minWidth && height >= minHeight;
      });
      const images: EmbeddedImage[] = structuredClone(
        kept.map((a) => ({
          ...a,
          occurrences: a.occurrences.filter((o) => wanted.has(o.pageNumber)),
        })),
      );
      if (options.annotations ?? this.options.annotations)
        await this.inventory.markAnnotated(images);
      return Object.assign(images, {
        ignoredCount: selected.length - kept.length,
        warnings: this.inventory.warnings(pages),
      });
    });
  }
  extractImage(id: string, options: ExtractImageOptions = {}): Promise<ExtractedImage> {
    return this.queue(options, async (signal) => {
      if (options.maxWidth !== undefined) positive(options.maxWidth, 'maxWidth');
      if (options.maxHeight !== undefined) positive(options.maxHeight, 'maxHeight');
      if (
        options.scale !== undefined &&
        !(typeof options.scale === 'number' && Number.isFinite(options.scale) && options.scale > 0)
      )
        throw new PdfExtractError('INVALID_ARGUMENT', 'scale must be a positive finite number');
      Document.booleans(options, ['composite', 'annotations']);
      const composite = options.composite ?? this.options.composite ?? false,
        annotations = options.annotations ?? this.options.annotations ?? false;
      const assets = await this.inventory.collect(options, signal);
      checkAbort(signal);
      const asset = assets.find((a) => a.id === id);
      if (!asset)
        throw new PdfExtractError('IMAGE_NOT_FOUND', 'Unknown image ID', {
          context: { imageId: id },
        });
      const occurrence =
        options.occurrenceId === undefined
          ? asset.occurrences[0]
          : asset.occurrences.find((o) => o.occurrenceId === options.occurrenceId);
      if (!occurrence)
        throw new PdfExtractError('INVALID_ARGUMENT', 'Unknown occurrenceId for this image', {
          context: { imageId: id, occurrenceId: options.occurrenceId },
        });
      const variant =
        options.maxWidth !== undefined || options.maxHeight !== undefined ? 'thumbnail' : 'full';
      let exported: { data: Uint8Array<ArrayBuffer>; width: number; height: number };
      let composited: ExtractedImage['composited'] = 'none';
      // Without anything above, clipping, graphics-state effects or scaling, the composite
      // equals the exact stored pixels: export those losslessly instead of rendering.
      if (
        composite &&
        ((options.scale ?? 1) !== 1 ||
          occurrence.overlaid ||
          occurrence.clipped ||
          asset.warnings.length ||
          (annotations &&
            (await this.inventory.annotations(occurrence.pageNumber)).some((a) =>
              intersects(a, occurrence.bbox),
            )))
      ) {
        const rendered = await renderComposite(
          this.engine,
          this.limits,
          asset,
          occurrence,
          this.inventory.placement(id, occurrence.occurrenceId),
          options,
          annotations,
          signal,
        );
        exported = { ...rendered, data: new Uint8Array(rendered.encoded) };
        composited = rendered.composited;
      } else
        exported = await exactExport(
          this.engine,
          this.limits,
          this.inventory.location(id),
          occurrence,
          options,
        );
      checkAbort(signal);
      options.onProgress?.({
        stage: 'export',
        completed: 1,
        total: 1,
        unit: 'images',
        imageId: id,
      });
      return {
        imageId: id,
        data: exported.data,
        mimeType: 'image/png',
        width: exported.width,
        height: exported.height,
        variant,
        composited,
      };
    });
  }
  getStructuredText(options: StructuredTextOptions = {}): Promise<StructuredText> {
    return this.queue(options, async (signal) => {
      const provider = this.options.ocr;
      const mode = options.ocr ?? (provider ? 'auto' : 'off');
      if (!['off', 'auto', 'always'].includes(mode))
        throw new PdfExtractError('INVALID_ARGUMENT', 'Invalid OCR mode');
      if (mode !== 'off' && !provider)
        throw new PdfExtractError('OCR_PROVIDER_REQUIRED', 'An OCR provider is required');
      if (options.errorMode && !['throw', 'collect'].includes(options.errorMode))
        throw new PdfExtractError('INVALID_ARGUMENT', 'Invalid errorMode');
      if (options.math && !['text', 'latex'].includes(options.math))
        throw new PdfExtractError('INVALID_ARGUMENT', 'Invalid math mode');
      Document.booleans(options, ['tables']);
      const minConfidence = options.minOcrConfidence ?? 0.3;
      if (!(minConfidence >= 0 && minConfidence <= 1))
        throw new PdfExtractError('INVALID_ARGUMENT', 'minOcrConfidence must be between 0 and 1');
      const selected = this.pages(options.pages);
      // OCR auto recognizes the images of the selected pages only.
      const images = mode === 'auto' ? await this.inventory.images(selected, options, signal) : [];
      // One page from its native text, OCR, tables and reading order. `signal` may be the
      // operation's or a pool's that also ends when another page fails.
      const extract = async (pageNumber: number, signal: AbortSignal): Promise<TextPage> => {
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
          tables: [],
          ocrStatus: mode === 'off' ? 'disabled' : 'not-needed',
          warnings: [],
        };
        let native: TextSpan[] = [],
          ocr: Recognition | undefined;
        // Font names and weights (for headings) and filled paths (outlined lettering) of the
        // page; a page whose operators cannot be read has neither.
        const style = await this.engine.style(pageNumber - 1).catch(() => undefined);
        // The same scan found the page's ruling lines: keep them for table detection.
        if (style) this.rules.set(pageNumber - 1, style.rules);
        const bold = new WeakSet<TextSpan>();
        try {
          // 1. Native text; with errorMode collect a failure leaves OCR to cover the page.
          try {
            native = await nativeSpans(page, viewport, style?.fonts, bold);
          } catch (error) {
            output.warnings.push(
              collectOrThrow(
                error,
                options.errorMode,
                signal,
                'TEXT_EXTRACTION_FAILED',
                'Page text extraction failed',
                { pageNumber },
              ),
            );
          }
          // One glyph scan of the page serves both uses below.
          let scanned: PageGlyphs | undefined;
          const glyphs = async () => {
            scanned ??= await this.engine.glyphs(pageNumber - 1);
            return scanned;
          };
          // Letter-spaced runs read again from their glyphs; on failure they stay as read.
          if (letterSpaced(native))
            try {
              respace(native, await glyphs(), viewport);
            } catch {
              checkAbort(signal);
            }
          // Math as LaTeX on TeX pages: a glyph scan of the page, spliced into its runs. On
          // failure the page keeps its plain text.
          if (options.math === 'latex' && native.length && style && isTexPage(style.fonts)) {
            try {
              // Math is what the page shows: an invisible layer's glyphs take no part.
              const page = await glyphs();
              const shown = { ...page, glyphs: page.glyphs.filter((g) => !g.hidden) };
              native = spliceMath(native, shown, page.rules, viewport, bold);
            } catch (error) {
              output.warnings.push(
                collectOrThrow(
                  error,
                  options.errorMode,
                  signal,
                  'MATH_EXTRACTION_FAILED',
                  'Page math extraction failed',
                  { pageNumber },
                ),
              );
            }
          }
          // Accents drawn as glyphs of their own join their letters (math has taken its own).
          composeAccents(native);
          // 2. OCR of the page's images or of the rendered page. Lettering drawn as vector
          // shapes is only readable from a render: no native text, many filled paths, and too
          // little image area to be a scanned page.
          if (mode !== 'off' && provider) {
            const imageArea = images
              .flatMap((image) => image.occurrences.filter((o) => o.pageNumber === pageNumber))
              .reduce((n, { bbox }) => n + bbox.width * bbox.height, 0);
            const outlined =
              native.reduce((n, s) => n + s.text.trim().length, 0) < 20 &&
              (style?.fills ?? 0) >= 50 &&
              imageArea < viewport.width * viewport.height * 0.5;
            ocr = await recognizePage({
              page,
              viewport,
              pageNumber,
              mode,
              outlined,
              minConfidence,
              provider,
              images,
              native,
              limits: this.limits,
              options,
              signal,
              renderLeniently: (render) => this.engine.renderLeniently(pageNumber - 1, render),
              raster: (image, occurrence, scale) =>
                uprightRaster(
                  this.engine,
                  this.limits,
                  this.inventory.location(image.id),
                  occurrence,
                  scale,
                ),
            });
          }
        } finally {
          page.cleanup();
        }
        // OCR auto relied on the page's image inventory.
        if (mode === 'auto') output.warnings.push(...this.inventory.warnings([pageNumber]));
        if (ocr) {
          output.warnings.push(...ocr.warnings);
          output.ocrStatus = ocr.status;
        }
        // Native spans of a poor text layer that recognition replaced are left out.
        let spans = [
          ...(ocr?.replaced.size ? native.filter((s) => !ocr?.replaced.has(s)) : native),
          ...(ocr?.spans ?? []),
        ];
        // Line numbers beside the text (manuscripts, patents) are no part of it.
        const numbered = lineNumbers(spans);
        if (numbered.size) spans = spans.filter((s) => !numbered.has(s));
        // 3. Tables, from ruling lines and text alignment.
        let tables: DetectedTable[] = [];
        if (options.tables !== false) {
          // A page drawing a few lines may hold a table its text alone does not suggest, such as
          // a one-column list of boxes.
          const detected = await pageTables(
            spans,
            () => this.pageRules(pageNumber, viewport.transform),
            pageNumber,
            signal,
            (style?.rules.rules.length ?? 0) >= 4,
          );
          tables = detected.tables;
          output.warnings.push(...detected.warnings);
          // Runs split at column rules: the parts keep their run's weight.
          spans = detected.spans;
          for (const [part, original] of detected.parts) if (bold.has(original)) bold.add(part);
        }
        // 4. Reading order and text.
        output.tables = tables.map((t) => t.table);
        output.blocks = markHeadings(
          layout(spans, tables, (span) => ocr?.lines.get(span)),
          { height: viewport.height, bold: (span) => bold.has(span) },
        );
        markFurniture(output);
        output.fullText = output.blocks.map((b) => b.text).join('\n\n');
        return output;
      };
      const results: TextPage[] = [];
      let completed = 0;
      const finish = (index: number, output: TextPage) => {
        results[index] = output;
        options.onProgress?.({
          stage: 'text',
          completed: ++completed,
          total: selected.length,
          unit: 'pages',
          pageNumber: output.pageNumber,
        });
      };
      // With an OCR provider that recognizes several rasters at once, as many pages are read
      // together: their recognition overlaps, the engine serving them in turn. Output order and
      // errors stay as when reading page by page.
      const width =
        mode !== 'off' && provider
          ? Math.min(Math.max(1, Math.floor(provider.concurrency ?? 1)), 8, selected.length)
          : 1;
      if (width <= 1)
        for (const [index, pageNumber] of selected.entries())
          finish(index, await extract(pageNumber, signal));
      else {
        const stop = new AbortController(),
          pool = AbortSignal.any([signal, stop.signal]);
        let next = 0;
        try {
          await Promise.all(
            Array.from({ length: width }, async () => {
              while (next < selected.length) {
                const index = next++;
                finish(index, await extract(selected[index], pool));
              }
            }),
          );
        } catch (error) {
          stop.abort();
          // A page that failed because another one did reports the original failure.
          checkAbort(signal);
          throw error;
        }
      }
      const pages = results;
      markRepeatedFurniture(pages);
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
  /** A page's ruling lines in canonical page points, scanned once per document. */
  private async pageRules(pageNumber: number, transform: number[]) {
    let found = this.rules.get(pageNumber - 1);
    if (!found) {
      found = await this.engine.rules(pageNumber - 1);
      this.rules.set(pageNumber - 1, found);
    }
    const scale = Math.sqrt(Math.abs(transform[0] * transform[3] - transform[1] * transform[2]));
    const rules: Rule[] = found.rules.map((r) => {
      const [x1, y1] = point(transform, r.x1, r.y1),
        [x2, y2] = point(transform, r.x2, r.y2);
      return { x1, y1, x2, y2, width: r.width * scale, ...(r.fill ? { fill: true } : {}) };
    });
    return { rules, truncated: found.truncated };
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.controller.abort();
    this.closing = this.engine.close().finally(() => {
      this.inventory.clear();
      this.rules.clear();
    });
    return this.closing;
  }
}

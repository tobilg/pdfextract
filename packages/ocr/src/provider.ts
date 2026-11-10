// Shared provider for the web (window and Web Worker) and Node entry points. The entry
// is selected by the package export conditions, never by sniffing globals at runtime.
import type { OcrProvider, OcrRaster, OcrResult, OperationOptions } from '@pdfextract/core';
import { checkAbort, PdfExtractError, positive } from '@pdfextract/core';
import type { PSM, Worker, WorkerOptions } from 'tesseract.js';

interface RawWorker {
  terminate(): unknown;
}
type WorkerFactory = (
  languages: string[],
  oem: number,
  options: Partial<WorkerOptions> & {
    onWorker(worker: RawWorker, reject: (reason: unknown) => void): void;
  },
) => Promise<Worker>;
/** Worker-pool and asset configuration. No worker or model is loaded until recognition begins. */
export interface TesseractOcrOptions {
  /** Nonempty Tesseract language identifiers, for example ['eng', 'deu']. Supply matching traineddata.gz files. */
  languages: readonly string[];
  /**
   * Maximum reusable worker count, 1–8; defaults to half the logical processors, at least one
   * and at most four. Workers start only when that many rasters are recognized at once.
   */
  concurrency?: number;
  /** Self-hosted asset locations; languageDataBaseUrl is required when recognition starts. */
  assets?: {
    /** Worker script location. Defaults to the packaged worker next to this module; bundled browser apps should supply the hosted worker.min.js URL. */
    workerUrl?: string | URL;
    /** Directory containing the shipped Tesseract LSTM core JS/WASM variants; defaults to the packaged assets/core. Supports Node filesystem paths and file URLs. */
    coreBaseUrl?: string | URL;
    /** Directory containing language.traineddata.gz files. No implicit language-model CDN is used. */
    languageDataBaseUrl?: string | URL;
  };
}
/**
 * Grayscale copy of an RGBA raster, composited over white. Tesseract thresholds colour images
 * per channel, where coloured text (green or blue on white) can vanish; luminance keeps it.
 */
function luminance({ data, width, height }: OcrRaster): Uint8Array {
  const gray = new Uint8Array(width * height);
  for (let p = 0, i = 0; p < gray.length; p++, i += 4) {
    const alpha = data[i + 3] / 255,
      luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    gray[p] = Math.round(luma * alpha + 255 * (1 - alpha));
  }
  return gray;
}
/** Half the logical processors (Node 21+ and browsers report them), one to four. */
export function defaultConcurrency(): number {
  const cores = Number(globalThis.navigator?.hardwareConcurrency);
  return Number.isFinite(cores) ? Math.max(1, Math.min(4, Math.floor(cores / 2))) : 1;
}
export function createProvider(
  options: TesseractOcrOptions,
  platform: 'web' | 'node',
): OcrProvider {
  const concurrency = positive(options.concurrency ?? defaultConcurrency(), 'concurrency');
  if (
    concurrency > 8 ||
    !options.languages.length ||
    options.languages.some((l) => !/^\w+$/.test(l))
  )
    throw new PdfExtractError(
      'INVALID_ARGUMENT',
      'Provide language codes and concurrency between 1 and 8',
    );
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const closing = new AbortController();
  const slots = Array.from({ length: concurrency }, () => ({
    tail: Promise.resolve() as Promise<unknown>,
    /** Recognitions queued on or running in this slot. */
    pending: 0,
    worker: undefined as Worker | undefined,
    loading: undefined as Promise<Worker> | undefined,
    raw: undefined as RawWorker | undefined,
    reject: undefined as ((reason: unknown) => void) | undefined,
    progress: undefined as OperationOptions['onProgress'],
  }));
  const terminations = new Set<Promise<unknown>>();
  function terminate(slot: (typeof slots)[number], reason: unknown) {
    slot.reject?.(reason);
    slot.reject = undefined;
    const raw = slot.raw;
    slot.raw = undefined;
    slot.worker = undefined;
    slot.loading = undefined;
    if (raw) {
      const task = Promise.resolve(raw.terminate());
      terminations.add(task);
      void task.finally(() => terminations.delete(task)).catch(() => {});
    }
  }
  async function recognize(
    slot: (typeof slots)[number],
    raster: OcrRaster,
    op: OperationOptions,
  ): Promise<OcrResult> {
    const signal = op.signal ? AbortSignal.any([op.signal, closing.signal]) : closing.signal;
    checkAbort(signal);
    positive(raster.width, 'width');
    positive(raster.height, 'height');
    if (
      raster.format !== 'rgba8' ||
      raster.stride !== raster.width * 4 ||
      raster.data.length !== raster.stride * raster.height
    )
      throw new PdfExtractError('INVALID_ARGUMENT', 'Expected tightly packed RGBA8 raster');
    // Explicit language path prevents Tesseract's implicit CDN default.
    const languagePath = options.assets?.languageDataBaseUrl;
    if (!languagePath)
      throw new PdfExtractError(
        'OCR_ASSET_UNAVAILABLE',
        'Set assets.languageDataBaseUrl to locally hosted traineddata.gz files',
      );
    slot.progress = op.onProgress;
    let rejectAbort: ((reason: unknown) => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const abort = () => {
      rejectAbort?.(new PdfExtractError('ABORTED', 'OCR cancelled'));
      terminate(slot, new PdfExtractError('ABORTED', 'OCR cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (!slot.loading)
        slot.loading = (async () => {
          const web = platform === 'web';
          const assets = new URL('./assets/', import.meta.url);
          const base =
            web && options.assets?.workerUrl
              ? new URL('.', new URL(String(options.assets.workerUrl), globalThis.location?.href))
              : assets;
          const moduleUrl = new URL(web ? 'tesseract.mjs' : 'tesseract-node.cjs', base).href;
          const module = await import(/* @vite-ignore */ moduleUrl);
          checkAbort(signal);
          const createWorker: WorkerFactory = module.createWorker ?? module.default;
          const worker = await createWorker([...options.languages], 1, {
            onWorker(raw, reject) {
              slot.raw = raw;
              slot.reject = reject;
            },
            errorHandler: () => {},
            langPath: String(languagePath),
            workerPath: String(
              options.assets?.workerUrl ??
                new URL(web ? 'worker.min.js' : 'node-worker.cjs', assets),
            ),
            // Always the packaged (or caller-hosted) core: never tesseract.js's CDN default.
            corePath: String(options.assets?.coreBaseUrl ?? new URL('core/', assets)),
            ...(web ? { workerBlobURL: false } : {}),
            cacheMethod: 'none',
            gzip: true,
            logger: (event) =>
              slot.progress?.({
                stage: 'ocr',
                completed: Math.round(event.progress * 100),
                total: 100,
                unit: 'tasks',
              }),
          });
          if (signal.aborted || closed) {
            terminate(slot, new PdfExtractError('ABORTED', 'OCR provider closed'));
            checkAbort(signal);
            throw new PdfExtractError('ABORTED', 'OCR provider closed');
          }
          slot.worker = worker;
          return worker;
        })();
      const worker = await Promise.race([slot.loading, aborted]);
      checkAbort(signal);
      // Tesseract's library default is a single uniform text block (PSM 6), which reads straight
      // across columns. Use automatic page segmentation (PSM 3), as the tesseract CLI does, and
      // pass the raster's resolution so size heuristics need not guess. 0 restores estimation.
      const dpi = raster.dpi && Math.round(Math.min(2400, Math.max(70, raster.dpi)));
      // A binary PNM (P5): a header and the gray samples, which Tesseract's image library
      // reads as is. A PNG costs a compression here and a decompression in the recognizer.
      const header = new TextEncoder().encode(`P5\n${raster.width} ${raster.height}\n255\n`),
        gray = luminance(raster),
        image = new Uint8Array(header.length + gray.length);
      image.set(header);
      image.set(gray, header.length);
      const read = async (mode: string) => {
        await Promise.race([
          worker.setParameters({
            tessedit_pageseg_mode: mode as PSM,
            user_defined_dpi: String(dpi || 0),
          }),
          aborted,
        ]);
        checkAbort(signal);
        return Promise.race([
          worker.recognize(
            image as unknown as Parameters<Worker['recognize']>[0],
            { rotateAuto: false, rotateRadians: 0 },
            { text: true, blocks: true },
          ),
          aborted,
        ]);
      };
      // A raster of scattered words (handwriting, forms) is read in sparse-text mode (PSM 11).
      const result = await read(raster.layout === 'sparse' ? '11' : '3');
      checkAbort(signal);
      const box = (b: { x0: number; y0: number; x1: number; y1: number }) => ({
        x: b.x0,
        y: b.y0,
        width: b.x1 - b.x0,
        height: b.y1 - b.y0,
      });
      return {
        text: result.data.text,
        lines: (result.data.blocks ?? []).flatMap((b) =>
          b.paragraphs.flatMap((p) =>
            p.lines.map((l) => ({
              text: l.text,
              bbox: box(l.bbox),
              words: l.words.map((w) => ({
                text: w.text,
                bbox: box(w.bbox),
                confidence: Math.max(0, Math.min(1, w.confidence / 100)),
              })),
            })),
          ),
        ),
        warnings: [],
      };
    } catch (error) {
      const initialized = !!slot.worker;
      terminate(slot, error);
      if (error instanceof PdfExtractError) throw error;
      throw new PdfExtractError(
        initialized ? 'OCR_FAILED' : 'OCR_ASSET_UNAVAILABLE',
        'Tesseract recognition failed',
        { cause: error },
      );
    } finally {
      signal.removeEventListener('abort', abort);
      slot.progress = undefined;
    }
  }
  return {
    concurrency,
    recognize(raster, op = {}) {
      if (closed)
        return Promise.reject(new PdfExtractError('DOCUMENT_CLOSED', 'OCR provider closed'));
      // The least busy slot, a started worker before one still to start: rasters recognized
      // one at a time reuse one worker, and further workers start only for overlapping work.
      const slot = slots.reduce((best, s) =>
        s.pending < best.pending || (s.pending === best.pending && s.worker && !best.worker)
          ? s
          : best,
      );
      slot.pending++;
      // Counted down before the caller sees the outcome, so its next raster finds the slot idle.
      const task = slot.tail
        .then(() => recognize(slot, raster, op))
        .finally(() => {
          slot.pending--;
        });
      slot.tail = task.catch(() => {});
      return task;
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closing.abort();
      closePromise = (async () => {
        await Promise.allSettled(slots.map((s) => s.tail));
        for (const slot of slots)
          terminate(slot, new PdfExtractError('ABORTED', 'OCR provider closed'));
        await Promise.all([...terminations]);
      })();
      return closePromise;
    },
  };
}

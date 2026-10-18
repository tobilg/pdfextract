// biome-ignore-all lint/suspicious/noExplicitAny: Private pinned engine ABI; never part of core public contracts.
import type { OpenPdfOptions, PdfInput } from './contracts.js';
import type { PageRules, RawImage } from './engine-types.js';
import { checkAbort, type ErrorCode, PdfExtractError, workerError } from './errors.js';
export interface Runtime {
  /** Node replaces the default web runtime (window or Web Worker) from its export condition. */
  platform: 'web' | 'node';
  read(url: URL, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>>;
  canvas?(width: number, height: number): { canvas: any; context: any };
  worker?(base: URL, workerUrl: string): any;
}
let runtime: Runtime = {
  platform: 'web',
  async read(url, signal) {
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error(`Asset request failed (${r.status}): ${url}`);
    return new Uint8Array(await r.arrayBuffer());
  },
};

export type { PageRules, RawImage } from './engine-types.js';
export function setRuntime(value: Runtime) {
  runtime = value;
}
// Web Workers have no document: render with OffscreenCanvas there.
function webCanvas(width: number, height: number) {
  if (typeof document === 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}
export function createCanvas(width: number, height: number) {
  if (runtime.canvas) return runtime.canvas(width, height);
  const canvas = webCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new PdfExtractError('RESOURCE_LIMIT_EXCEEDED', 'Canvas allocation failed');
  return { canvas, context };
}
/** PDF.js canvas factory for documentless Web Workers; its default factory needs a DOM. */
class OffscreenCanvasFactory {
  create(width: number, height: number) {
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext('2d', { willReadFrequently: true }) };
  }
  reset(entry: { canvas: OffscreenCanvas }, width: number, height: number) {
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    entry.canvas.width = width;
    entry.canvas.height = height;
  }
  destroy(entry: { canvas: OffscreenCanvas | null; context: unknown }) {
    if (entry.canvas) {
      entry.canvas.width = 0;
      entry.canvas.height = 0;
    }
    entry.canvas = null;
    entry.context = null;
  }
}
/** SVG transfer-function filters need a DOM; workers render without them, like PDF.js in Node. */
class NoFilterFactory {
  addFilter() {
    return 'none';
  }
  addHCMFilter() {
    return 'none';
  }
  addAlphaFilter() {
    return 'none';
  }
  addLuminosityFilter() {
    return 'none';
  }
  addHighlightHCMFilter() {
    return 'none';
  }
  destroy() {}
}
export async function openEngine(bytes: Uint8Array<ArrayBuffer>, options: OpenPdfOptions) {
  const base = new URL(options.assets?.baseUrl ?? './assets/', import.meta.url);
  const moduleUrl = new URL('pdf.mjs', base).href;
  const pdfjs = await import(/* @vite-ignore */ moduleUrl).catch((cause) => {
    throw new PdfExtractError(
      'UNSUPPORTED_PDF_FEATURE',
      'Engine module asset could not be loaded',
      { cause },
    );
  });
  const workerUrl = String(options.assets?.workerUrl ?? new URL('pdf.worker.mjs', base));
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const web = runtime.platform === 'web';
  const dom = web && typeof document !== 'undefined';
  // Every document gets its own engine worker, ended by close(). The worker extension keeps
  // per-document state (the last page's operator list), so never share a worker or port.
  let worker: Worker | undefined;
  let pdfWorker: any;
  if (runtime.worker) worker = runtime.worker(base, workerUrl);
  else if (typeof Worker !== 'undefined') worker = new Worker(workerUrl, { type: 'module' });
  if (worker) pdfWorker = new pdfjs.PDFWorker({ port: worker });
  let rejectFatal: (error: unknown) => void;
  let workerFailed = false;
  const fatal = new Promise<never>((_, reject) => {
    rejectFatal = reject;
  });
  void fatal.catch(() => {});
  const onError = (event: ErrorEvent) => {
    workerFailed = true;
    rejectFatal(
      new PdfExtractError('UNSUPPORTED_PDF_FEATURE', 'Engine worker failed to load or execute', {
        cause: event.error ?? new Error(event.message),
      }),
    );
  };
  worker?.addEventListener('error', onError);
  const assetPath = (path: string) => {
    const url = new URL(path, base);
    return url.protocol === 'file:' ? decodeURIComponent(url.pathname) : url.href;
  };
  const wasmBase = options.assets?.wasmUrl
    ? new URL('.', new URL(String(options.assets.wasmUrl), base))
    : new URL('wasm/', base);
  const task = pdfjs.getDocument({
    data: bytes,
    worker: pdfWorker,
    password: options.password,
    isEvalSupported: false,
    enableXfa: false,
    stopAtErrors: true,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    useSystemFonts: false,
    disableFontFace: !dom,
    cMapUrl: assetPath('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: assetPath('standard_fonts/'),
    wasmUrl: wasmBase.protocol === 'file:' ? decodeURIComponent(wasmBase.pathname) : wasmBase.href,
    iccUrl: assetPath('iccs/'),
    useWorkerFetch: web,
    ...(web && !dom
      ? { CanvasFactory: OffscreenCanvasFactory, FilterFactory: NoFilterFactory }
      : {}),
  });
  const abort = () => {
    rejectFatal(new PdfExtractError('ABORTED', 'Open cancelled'));
    void task.destroy();
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    checkAbort(options.signal);
    const doc = await Promise.race([task.promise, fatal]);
    checkAbort(options.signal);
    const assets = await Promise.all([
      runtime.read(new URL('qcms_bg.wasm', wasmBase), options.signal),
      runtime.read(new URL('iccs/CGATS001Compat-v2-micro.icc', base), options.signal),
    ]);
    await Promise.race([
      doc._transport.messageHandler.sendWithPromise('PdfextractConfigure', {
        'qcms_bg.wasm': assets[0],
        'CGATS001Compat-v2-micro.icc': assets[1],
      }),
      fatal,
    ]);
    const scan = async (
      pageIndex: number,
      data: Record<string, unknown>,
      fallback: ErrorCode = 'UNSUPPORTED_IMAGE_FEATURE',
    ): Promise<any> => {
      const result = await Promise.race([
        doc._transport.messageHandler.sendWithPromise('PdfextractScan', { pageIndex, ...data }),
        fatal,
      ]);
      if (result.error) throw workerError(result.error, fallback, pageIndex + 1);
      return result.value;
    };
    return {
      doc,
      /**
       * Image draws of a page with overlay flags. `degraded` says why the page could only be
       * read leniently (skipping broken operators), when it could not be read strictly.
       */
      async inventory(pageIndex: number) {
        const value = await scan(pageIndex, { collect: ['images', 'overlay'] });
        return value as { images: RawImage[]; degraded?: string };
      },
      /** Decode one image of a page within the budgets, optionally oriented and PNG-encoded. */
      async decode(
        pageIndex: number,
        decodeId: string,
        maxPixels: number,
        maxBytes: number,
        exportOptions: {
          encode?: boolean;
          maxWidth?: number;
          maxHeight?: number;
          /** Linear part of an orientation transform; omitted keeps the stored orientation. */
          orient?: readonly number[];
        } = {},
      ) {
        return scan(pageIndex, {
          collect: ['images'],
          decodeId,
          maxPixels,
          maxBytes,
          ...exportOptions,
        });
      },
      /** Engine operator and annotation-mode constants for composite rendering. */
      OPS: pdfjs.OPS as Record<string, number>,
      AnnotationMode: pdfjs.AnnotationMode as Record<string, number>,
      /** Encode an owned RGBA raster as PNG in the worker, optionally as a bounded preview. */
      async encode(
        pixels: Uint8Array<ArrayBuffer>,
        width: number,
        height: number,
        maxWidth?: number,
        maxHeight?: number,
      ) {
        return (await Promise.race([
          doc._transport.messageHandler.sendWithPromise(
            'PdfextractEncode',
            { pixels, width, height, maxWidth, maxHeight },
            [pixels.buffer],
          ),
          fatal,
        ])) as { width: number; height: number; encoded: Uint8Array };
      },
      /**
       * Runs `render` with the page's renders lenient (skipping broken operators, as viewers
       * do), so content errors that text extraction reports do not leave the render blank.
       */
      async renderLeniently<T>(pageIndex: number, render: () => Promise<T>): Promise<T> {
        const mode = (lenient: boolean) =>
          Promise.race([
            doc._transport.messageHandler.sendWithPromise('PdfextractRenderMode', {
              pageIndex,
              lenient,
            }),
            fatal,
          ]);
        await mode(true);
        try {
          return await render();
        } finally {
          await mode(false);
        }
      },
      /** Axis-aligned ruling lines of a page in PDF space, for table detection. */
      async rules(pageIndex: number) {
        const value = await scan(pageIndex, { collect: ['rules'] }, 'UNSUPPORTED_PDF_FEATURE');
        return (value as { rules: PageRules }).rules;
      },
      async close() {
        try {
          await task.destroy();
        } finally {
          await worker?.terminate();
          pdfWorker?.destroy();
        }
      },
    };
  } catch (error) {
    if (!workerFailed) await task.destroy().catch(() => {});
    await worker?.terminate();
    pdfWorker?.destroy();
    checkAbort(options.signal);
    if (error instanceof PdfExtractError) throw error;
    const e = error as { name?: string; code?: number };
    throw new PdfExtractError(
      e.name === 'PasswordException'
        ? options.password
          ? 'INVALID_PASSWORD'
          : 'PASSWORD_REQUIRED'
        : 'INVALID_PDF',
      'Could not open PDF',
      { cause: error },
    );
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
}
/** An open engine document handle with the pdfextract worker extensions. */
export type Engine = Awaited<ReturnType<typeof openEngine>>;
/** An engine page proxy. */
export type Page = Awaited<ReturnType<Engine['doc']['getPage']>>;
export async function inputBytes(input: PdfInput, max: number) {
  if (!(input instanceof Blob) && !(input instanceof Uint8Array) && !(input instanceof ArrayBuffer))
    throw new PdfExtractError('INVALID_ARGUMENT', 'Expected Blob, ArrayBuffer or Uint8Array');
  const size = input instanceof Blob ? input.size : input.byteLength;
  if (!Number.isSafeInteger(size) || size > max)
    throw new PdfExtractError('RESOURCE_LIMIT_EXCEEDED', 'Input exceeds maxInputBytes');
  if (input instanceof Blob) return new Uint8Array(await input.arrayBuffer());
  if (input instanceof Uint8Array) return new Uint8Array(input);
  if (input instanceof ArrayBuffer) return new Uint8Array(input.slice(0));
  throw new PdfExtractError('INVALID_ARGUMENT', 'Expected Blob, ArrayBuffer or Uint8Array');
}

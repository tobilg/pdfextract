// biome-ignore-all lint/suspicious/noExplicitAny: Private pinned engine ABI; never part of core public contracts.
import type { OpenPdfOptions, PdfInput } from './contracts.js';
import { checkAbort, PdfExtractError } from './errors.js';
export interface Runtime {
  read(url: URL, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>>;
  canvas?(width: number, height: number): { canvas: any; context: any };
  worker?(base: URL, workerUrl: string): any;
}
let runtime: Runtime = {
  async read(url, signal) {
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error(`Asset request failed (${r.status}): ${url}`);
    return new Uint8Array(await r.arrayBuffer());
  },
};
export function setRuntime(value: Runtime) {
  runtime = value;
}
export function createCanvas(width: number, height: number) {
  if (runtime.canvas) return runtime.canvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new PdfExtractError('RESOURCE_LIMIT_EXCEEDED', 'Canvas allocation failed');
  return { canvas, context };
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
  let worker: Worker | undefined;
  let pdfWorker: any;
  if (typeof window !== 'undefined') {
    worker = new Worker(workerUrl, { type: 'module' });
    pdfWorker = new pdfjs.PDFWorker({ port: worker });
  } else if (runtime.worker) {
    worker = runtime.worker(base, workerUrl);
    pdfWorker = new pdfjs.PDFWorker({ port: worker });
  }
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
        cause: event.message,
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
    disableFontFace: typeof window === 'undefined',
    cMapUrl: assetPath('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: assetPath('standard_fonts/'),
    wasmUrl: wasmBase.protocol === 'file:' ? decodeURIComponent(wasmBase.pathname) : wasmBase.href,
    iccUrl: assetPath('iccs/'),
    useWorkerFetch: typeof window !== 'undefined',
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
    return {
      doc,
      async images(
        pageIndex: number,
        decodeId?: string,
        maxPixels?: number,
        maxBytes?: number,
        exportOptions: { encode?: boolean; maxWidth?: number; maxHeight?: number } = {},
      ) {
        const result = await Promise.race([
          doc._transport.messageHandler.sendWithPromise('PdfextractImages', {
            pageIndex,
            decodeId,
            maxPixels,
            maxBytes,
            ...exportOptions,
          }),
          fatal,
        ]);
        if (result.error) {
          const code = result.error.split(':')[0];
          throw new PdfExtractError(
            ['RESOURCE_LIMIT_EXCEEDED', 'IMAGE_NOT_FOUND', 'UNSUPPORTED_IMAGE_FEATURE'].includes(
              code,
            )
              ? code
              : 'UNSUPPORTED_IMAGE_FEATURE',
            result.error,
            { context: { pageNumber: pageIndex + 1 } },
          );
        }
        return result.value;
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

import {
  checkAbort,
  type EmbeddedImage,
  type OcrProvider,
  openPdf,
  type PdfDocument,
  type PdfLimits,
  type ProgressEvent,
  type StructuredText,
} from '@pdfextract/core';
import { createTesseractOcr } from '@pdfextract/ocr';

export const DEMO_LIMITS: PdfLimits = {
  maxInputBytes: 64 * 1024 * 1024,
  maxPages: 1000,
  maxImagePixels: 32_000_000,
  maxDecodedBytes: 512 * 1024 * 1024,
  maxOcrPixels: 4_000_000,
};
export interface Result {
  text: StructuredText;
  images: readonly EmbeddedImage[];
  /** Images left out by the minimum size filter. */
  ignoredImages: number;
}

export interface SessionOptions {
  ocr: boolean;
  ocrMode: 'auto' | 'always';
  language: string;
  password: string;
  /** Optional minimum image width/height in pixels; smaller images are not listed. */
  minWidth?: number;
  minHeight?: number;
}

/** One tab-local document. No storage adapter, upload endpoint or browser database. */
export class PdfSession {
  readonly controller = new AbortController();
  private pdf?: PdfDocument;
  private provider?: OcrProvider;
  private opening?: Promise<PdfDocument>;
  private closing?: Promise<void>;

  constructor(readonly file: File) {}

  async extract(
    options: SessionOptions,
    onProgress: (event: ProgressEvent) => void,
  ): Promise<Result> {
    const base = new URL('pdfextract/', new URL(import.meta.env.BASE_URL, document.baseURI));
    if (options.ocr) {
      this.provider = createTesseractOcr({
        languages: [options.language],
        concurrency: 1,
        assets: {
          workerUrl: new URL('ocr/worker.min.js', base),
          coreBaseUrl: new URL('ocr/core/', base),
          languageDataBaseUrl: new URL('languages/', base),
        },
      });
    }
    const operation = { signal: this.controller.signal, onProgress };
    this.opening = openPdf(this.file, {
      ...operation,
      password: options.password || undefined,
      ocr: this.provider,
      assets: { baseUrl: new URL('core/', base) },
      limits: DEMO_LIMITS,
    }).then((pdf) => {
      this.pdf = pdf;
      return pdf;
    });
    const pdf = await this.opening;
    checkAbort(this.controller.signal);
    const text = await pdf.getStructuredText({
      ...operation,
      ocr: options.ocr ? options.ocrMode : 'off',
      errorMode: 'collect',
    });
    const images = await pdf.getImages({
      ...operation,
      minWidth: options.minWidth,
      minHeight: options.minHeight,
    });
    return { text, images, ignoredImages: images.ignoredCount };
  }

  async image(id: string, thumbnail: boolean, signal: AbortSignal) {
    checkAbort(this.controller.signal);
    if (!this.pdf) throw new Error('Open a PDF before exporting an image.');
    return this.pdf.extractImage(id, {
      signal: AbortSignal.any([signal, this.controller.signal]),
      ...(thumbnail ? { maxWidth: 360, maxHeight: 240 } : {}),
    });
  }

  close(): Promise<void> {
    this.controller.abort();
    this.closing ??= (async () => {
      await this.opening?.catch(() => undefined);
      const results = await Promise.allSettled([this.pdf?.close(), this.provider?.close()]);
      this.pdf = undefined;
      this.provider = undefined;
      const errors = results.filter((result) => result.status === 'rejected');
      if (errors.length)
        throw new AggregateError(
          errors.map((error) => error.reason),
          'PDF cleanup failed',
        );
    })();
    return this.closing;
  }
}

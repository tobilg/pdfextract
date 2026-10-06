// Node entry, selected by the package's `node` export condition.
import type { OcrProvider } from '@pdfextract/core';
import { createProvider, type TesseractOcrOptions } from './provider.js';

export type { TesseractOcrOptions } from './provider.js';
/** Node variant of createTesseractOcr, using worker threads and the packaged core. */
export function createTesseractOcr(options: TesseractOcrOptions): OcrProvider {
  return createProvider(options, 'node');
}

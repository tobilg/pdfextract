/**
 * Lazy, self-hosted Tesseract recognition implementing core's caller-owned OCR contract.
 * @module @pdfextract/ocr
 * @group @pdfextract/ocr
 */
import type { OcrProvider } from '@pdfextract/core';
import { createProvider, type TesseractOcrOptions } from './provider.js';

export type { TesseractOcrOptions } from './provider.js';
/**
 * Create a reusable OCR provider without initializing its workers.
 * @param options - Languages, bounded concurrency and explicitly hosted models/runtime assets.
 * @returns A caller-owned provider; await close after all borrowing documents finish.
 * @remarks Word boxes refer to the supplied tightly packed RGBA8 raster. Automatic rotation is disabled.
 * Works in windows and Web Workers; Node resolves the package's `node` export condition instead.
 * @throws Invalid configuration fails immediately; missing assets fail on recognition with OCR_ASSET_UNAVAILABLE.
 */
export function createTesseractOcr(options: TesseractOcrOptions): OcrProvider {
  return createProvider(options, 'web');
}

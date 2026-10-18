// The complete extraction, shared by the Web Worker and the main-thread variant of worker.html.
import { openPdf, PdfExtractError } from '@pdfextract/core';
import { createTesseractOcr } from '@pdfextract/ocr';

export interface ExtractRequest {
  pdf: ArrayBuffer;
  ocr: 'off' | 'auto' | 'always';
  /** Detect tables (core's default is on; the example keeps it off unless requested). */
  tables?: boolean;
  /** Export overlaid images as they appear on the page, and return their PNG bytes. */
  composite?: boolean;
  /** Export every image a second time and report whether exact exports came out identical. */
  repeat?: boolean;
}
export type ExtractResponse =
  | {
      ok: true;
      dom: boolean;
      text: string;
      tables: { detection: string; rowCount: number; columnCount: number; cells: string[] }[];
      images: {
        width: number;
        height: number;
        bytes: number;
        overlaid: boolean;
        clipped: boolean;
        composited: string;
        png?: Uint8Array;
      }[];
      /** With `repeat`: whether every exact export (composited 'none') was byte-identical. */
      repeatable?: boolean;
    }
  | { ok: false; error: string };

export async function extract(data: ExtractRequest): Promise<ExtractResponse> {
  const base = new URL(import.meta.env.BASE_URL, location.origin);
  const ocr =
    data.ocr === 'off'
      ? undefined
      : createTesseractOcr({
          languages: ['eng', 'deu'],
          assets: {
            workerUrl: new URL('pdfextract/ocr/worker.min.js', base),
            coreBaseUrl: new URL('pdfextract/ocr/core/', base),
            languageDataBaseUrl: new URL('pdfextract/languages/', base),
          },
        });
  try {
    const pdf = await openPdf(data.pdf, {
      ocr,
      composite: !!data.composite,
      assets: {
        baseUrl: new URL('pdfextract/core/', base),
        workerUrl: new URL('pdfextract/core/pdf.worker.mjs', base),
        wasmUrl: new URL('pdfextract/core/wasm/', base),
      },
    });
    try {
      const text = await pdf.getStructuredText({ ocr: data.ocr, tables: !!data.tables });
      const images = [],
        listed = await pdf.getImages();
      for (const image of listed) {
        const png = await pdf.extractImage(image.id);
        images.push({
          width: png.width,
          height: png.height,
          bytes: png.data.byteLength,
          overlaid: image.occurrences[0].overlaid,
          clipped: image.occurrences[0].clipped,
          composited: png.composited,
          ...(data.composite || data.repeat ? { png: png.data } : {}),
        });
      }
      let repeatable: boolean | undefined;
      if (data.repeat) {
        repeatable = true;
        for (const [i, image] of listed.entries()) {
          const again = await pdf.extractImage(image.id);
          const first = images[i].png;
          if (again.composited === 'none' && first && !sameBytes(first, again.data))
            repeatable = false;
        }
      }
      return {
        ok: true,
        dom: typeof document !== 'undefined',
        text: text.fullText,
        tables: text.pages.flatMap((page) =>
          page.tables.map((table) => ({
            detection: table.detection,
            rowCount: table.rowCount,
            columnCount: table.columnCount,
            cells: table.cells.map((cell) => cell.text),
          })),
        ),
        images,
        ...(repeatable === undefined ? {} : { repeatable }),
      };
    } finally {
      await pdf.close();
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof PdfExtractError ? `${error.code}: ${error.message}` : String(error),
    };
  } finally {
    await ocr?.close();
  }
}
function sameBytes(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

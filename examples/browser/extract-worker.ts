// Runs the complete extraction inside a dedicated module worker, where no DOM exists.
import { openPdf, PdfExtractError } from '@pdfextract/core';
import { createTesseractOcr } from '@pdfextract/ocr';

export interface ExtractRequest {
  pdf: ArrayBuffer;
  ocr: 'off' | 'auto' | 'always';
}
export type ExtractResponse =
  | {
      ok: true;
      dom: boolean;
      text: string;
      images: { width: number; height: number; bytes: number }[];
    }
  | { ok: false; error: string };

const reply = (response: ExtractResponse) => self.postMessage(response);
self.onmessage = async ({ data }: MessageEvent<ExtractRequest>) => {
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
      assets: {
        baseUrl: new URL('pdfextract/core/', base),
        workerUrl: new URL('pdfextract/core/pdf.worker.mjs', base),
        wasmUrl: new URL('pdfextract/core/wasm/', base),
      },
    });
    try {
      const text = await pdf.getStructuredText({ ocr: data.ocr });
      const images = [];
      for (const image of await pdf.getImages()) {
        const png = await pdf.extractImage(image.id);
        images.push({ width: png.width, height: png.height, bytes: png.data.byteLength });
      }
      reply({ ok: true, dom: typeof document !== 'undefined', text: text.fullText, images });
    } finally {
      await pdf.close();
    }
  } catch (error) {
    reply({
      ok: false,
      error: error instanceof PdfExtractError ? `${error.code}: ${error.message}` : String(error),
    });
  } finally {
    await ocr?.close();
  }
};

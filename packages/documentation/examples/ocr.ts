import { openPdf, type PdfInput } from '@pdfextract/core';
import { createTesseractOcr } from '@pdfextract/ocr';

/** assetBase is an absolute directory URL with a trailing slash. */
export async function recognizePdf(input: PdfInput, assetBase: URL, signal?: AbortSignal) {
  const ocr = createTesseractOcr({
    languages: ['eng'],
    assets: {
      workerUrl: new URL('ocr/worker.min.js', assetBase),
      coreBaseUrl: new URL('ocr/core/', assetBase),
      languageDataBaseUrl: new URL('languages/', assetBase),
    },
  });
  try {
    const pdf = await openPdf(input, {
      ocr,
      signal,
      assets: { baseUrl: new URL('core/', assetBase) },
    });
    try {
      return await pdf.getStructuredText({ ocr: 'auto', signal });
    } finally {
      await pdf.close();
    }
  } finally {
    await ocr.close();
  }
}

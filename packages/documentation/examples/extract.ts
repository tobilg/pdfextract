import { openPdf, type PdfInput } from '@pdfextract/core';

/** Extract native text and independent image exports from a whole PDF. */
export async function extractNative(input: PdfInput) {
  const pdf = await openPdf(input);
  try {
    const text = await pdf.getStructuredText({ ocr: 'off' });
    const exports = [];
    for (const image of await pdf.getImages()) {
      const full = await pdf.extractImage(image.id);
      const thumbnail = await pdf.extractImage(image.id, { maxWidth: 320, maxHeight: 240 });
      exports.push({ image, full, thumbnail });
    }
    return { text, exports };
  } finally {
    await pdf.close();
  }
}

import { readFile, writeFile } from 'node:fs/promises';
import { init } from '@embedpdf/pdfium';

const wasm = await readFile(
  import.meta.resolve('@embedpdf/pdfium/pdfium.wasm').replace('file://', ''),
);
const p = await init({ wasmBinary: wasm });
p.PDFiumExt_Init();
const result = { binding: '@embedpdf/pdfium@2.15.1', fixtures: [] };
for (const name of ['baseline', 'large-small', 'clipped-rotated']) {
  const bytes = await readFile(`tests/fixtures/${name}.pdf`),
    ptr = p.pdfium.wasmExports.malloc(bytes.length);
  p.pdfium.HEAPU8.set(bytes, ptr);
  const doc = p.FPDF_LoadMemDocument(ptr, bytes.length, 0),
    page = p.FPDF_LoadPage(doc, 0);
  try {
    const text = p.FPDFText_LoadPage(page);
    const chars = p.FPDFText_CountChars(text);
    p.FPDFText_ClosePage(text);
    const images = [];
    function visit(obj) {
      const type = p.FPDFPageObj_GetType(obj);
      if (type === 5)
        for (let i = 0; i < p.FPDFFormObj_CountObjects(obj); i++)
          visit(p.FPDFFormObj_GetObject(obj, i));
      if (type === 3) {
        const dims = p.pdfium.wasmExports.malloc(8);
        p.FPDFImageObj_GetImagePixelSize(obj, dims, dims + 4);
        const native = [p.pdfium.getValue(dims, 'i32'), p.pdfium.getValue(dims + 4, 'i32')];
        p.pdfium.wasmExports.free(dims);
        const bitmap = p.FPDFImageObj_GetRenderedBitmap(doc, page, obj);
        try {
          images.push({
            native,
            rendered: [p.FPDFBitmap_GetWidth(bitmap), p.FPDFBitmap_GetHeight(bitmap)],
            clipPaths: p.FPDFClipPath_CountPaths(p.FPDFPageObj_GetClipPath(obj)),
          });
        } finally {
          p.FPDFBitmap_Destroy(bitmap);
        }
      }
    }
    for (let i = 0; i < p.FPDFPage_CountObjects(page); i++) visit(p.FPDFPage_GetObject(page, i));
    result.fixtures.push({ name, chars, images });
  } finally {
    p.FPDF_ClosePage(page);
    p.FPDF_CloseDocument(doc);
    p.pdfium.wasmExports.free(ptr);
  }
}
console.log(JSON.stringify(result, null, 2));
await writeFile('docs/adr/pdfium-spike-results.json', `${JSON.stringify(result, null, 2)}\n`);

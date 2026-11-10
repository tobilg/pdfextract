# @pdfextract/ocr

Lazy Tesseract.js 7 provider for `@pdfextract/core`, browser and Node ≥22.12.0.
Tesseract recognizes rasters; core parses the PDF and supplies their page transforms.

## Installation

```sh
pnpm add @pdfextract/core @pdfextract/ocr
```

Supply Tesseract-compatible language models separately.

## Usage

For this Node example, put `eng.traineddata.gz` in a `models/` directory next to the
script. Package runtime assets are resolved automatically in Node:

```ts
import { readFile } from 'node:fs/promises';
import { openPdf } from '@pdfextract/core';
import { createTesseractOcr } from '@pdfextract/ocr';

const ocr = createTesseractOcr({
  languages: ['eng'],
  assets: { languageDataBaseUrl: new URL('./models/', import.meta.url) },
});
try {
  const pdf = await openPdf(await readFile('input.pdf'), { ocr });
  try {
    const text = await pdf.getStructuredText({ ocr: 'auto' });
    console.log(text.fullText);
  } finally {
    await pdf.close();
  }
} finally {
  await ocr.close();
}
```

Add `'deu'` and supply `deu.traineddata.gz` for German recognition. In browsers, pass a
whole `File` to core and configure all worker/model URLs using the
[self-hosted asset guide](../documentation/guides/ocr-and-assets.md).

## Lifecycle

The factory is synchronous and performs no initialization/download. First recognition
loads a reusable worker. Concurrency defaults to half the logical processors, from one to
four, configurable 1–8; a further worker starts only when rasters overlap, and core then
reads as many pages at once. Each worker holds its own Tesseract instance: set
`concurrency: 1` where memory is tight. The caller owns
the provider: multiple PDFs may share it, and closing one PDF does not terminate it.
`close()` is idempotent; cancellation terminates a running or initializing worker.
Missing models reject with `OCR_ASSET_UNAVAILABLE`, not a pending initialization promise.

## Self-hosted assets

Language paths are **required at recognition time** to prevent an implicit external CDN.
Use Tesseract-compatible `eng.traineddata.gz`, `deu.traineddata.gz`, etc. Model files
are deliberately separate from the tarball. For browsers, copy **all** `dist/assets`
files and set `workerUrl` to the copied `worker.min.js`, `coreBaseUrl` to its `core/`
directory, and `languageDataBaseUrl` to your models directory. The patched
`tesseract.mjs` controller is loaded beside `worker.min.js`. The same configuration works
from a window or a dedicated Web Worker. Node resolves the package's `node` export
condition and uses the bundled Node controller/worker and the packaged Tesseract core,
so no `tesseract.js` dependency is installed. Node model, worker and core-directory paths
may be absolute paths or file URLs. Only the LSTM cores are shipped (baseline, SIMD and
relaxed-SIMD); the matching variant is chosen at runtime. No shared-memory/
cross-origin-isolation headers are required.

## Recognition and errors

The provider accepts tightly packed RGBA8, returns pixel-coordinate words/lines and
confidence in [0,1]. It recognizes a grayscale copy composited over white, because
Tesseract's per-channel thresholding of colour images can lose coloured text. It runs
Tesseract's automatic page segmentation (PSM 3, as the `tesseract` CLI does, rather than
the library's single-block default) and passes the raster's `dpi`, when core supplies it,
as the source resolution. On pages larger than any paper, whose geometry may say little
about the scan, an image that yields no words is read once more without it, and
Tesseract estimates the resolution. A raster marked `layout: 'sparse'` (core asks for it
when a page yielded no text at all) is read in sparse-text mode (PSM 11). It uses no
automatic rotation/resizing; core prepares the working raster and maps recognition
geometry back through its own preprocessing. `auto` in core
visits image regions even on pages containing native text (not images that native text
covers by 30% or more, such as backgrounds and watermarks), enlarging regions shown below
200 DPI toward 300 DPI, and renders a page without native text that is drawn with many
vector shapes (outlined lettering). `always` renders every page at up to 300 DPI. Both stay
within `maxOcrPixels`; a larger image is reduced to fit it. Core drops words below its
`minOcrConfidence` option (default 0.3).
Native text wins overlapping normalized matching words; distinct placements remain.
Automatic detection of arbitrary page layouts/languages or guaranteed OCR accuracy is
not claimed. Test thresholds require the known English/German sentinel words and geometry.

Runtime errors include `INVALID_ARGUMENT`, `OCR_ASSET_UNAVAILABLE`, `OCR_FAILED`,
`ABORTED`, and `DOCUMENT_CLOSED`. Progress reports OCR stages. Engine types are private;
the public provider contract belongs to core. This package does not own PDF handles or storage.

## License

MIT. Tesseract, Leptonica, bundled codecs and math licenses are included in
`THIRD_PARTY_NOTICES`; model licenses must be hosted with separately supplied models.

# @pdfextract/ocr

Lazy Tesseract.js 7 provider for `@pdfextract/core`, browser and Node ≥22.12.0.
Tesseract recognizes rasters; core parses the PDF and supplies their page transforms.

## Installation

```sh
pnpm add @pdfextract/core @pdfextract/ocr
```

Before the first npm release, install the local core and OCR `.tgz` files produced by
`pnpm pack` in the repository. Supply Tesseract-compatible language models separately.

## Usage

For this Node example, put `eng.traineddata.gz` in a `models/` directory next to the
script. Package runtime assets are resolved automatically in Node:

```ts
import { readFile } from 'node:fs/promises';
import { openPdf } from '@pdfextract/core';
import { createTesseractOcr } from '@pdfextract/ocr';

const ocr = createTesseractOcr({
  languages: ['eng'],
  concurrency: 1,
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
loads a reusable worker. Concurrency defaults to 1, configurable 1–8. The caller owns
the provider: multiple PDFs may share it, and closing one PDF does not terminate it.
`close()` is idempotent; cancellation terminates a running or initializing worker.
Missing models reject with `OCR_ASSET_UNAVAILABLE`, not a pending initialization promise.

## Self-hosted assets

Language paths are **required at recognition time** to prevent an implicit external CDN.
Use Tesseract-compatible `eng.traineddata.gz`, `deu.traineddata.gz`, etc. Model files
are deliberately separate from the tarball. For browsers, copy **all** `dist/assets`
files and set `workerUrl` to the copied `worker.min.js`, `coreBaseUrl` to its `core/`
directory, and `languageDataBaseUrl` to your models directory. The patched
`tesseract.mjs` controller is loaded beside `worker.min.js`. Node defaults to the
included patched Node controller/worker and installed Tesseract core. Node model,
worker and core-directory paths may be absolute paths or file URLs; explicit core
directories use the matching SIMD variant from the supplied directory. No shared-memory/
cross-origin-isolation headers are required.

## Recognition and errors

The provider accepts tightly packed RGBA8, returns pixel-coordinate words/lines and
confidence in [0,1]. It uses no automatic rotation/resizing; core maps recognition
geometry through its own preprocessing. `auto` in core visits image regions even on
pages containing native text. `always` uses a bounded full-page working raster.
Native text wins overlapping normalized matching words; distinct placements remain.
Automatic detection of arbitrary page layouts/languages or guaranteed OCR accuracy is
not claimed. Test thresholds require the known English/German sentinel words and geometry.

Runtime errors include `INVALID_ARGUMENT`, `OCR_ASSET_UNAVAILABLE`, `OCR_FAILED`,
`ABORTED`, and `DOCUMENT_CLOSED`. Progress reports OCR stages. Engine types are private;
the public provider contract belongs to core. This package does not own PDF handles or storage.

## License

License decision pending: UNLICENSED local prerelease. Tesseract, Leptonica, bundled
codecs and math licenses are included in `THIRD_PARTY_NOTICES`; model licenses must be
hosted with separately supplied models. See the repository licensing inventory.

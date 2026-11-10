---
title: OCR and self-hosted assets
group: Guides
---

# OCR and self-hosted assets

{@link "@pdfextract/ocr".createTesseractOcr} creates a provider lazily. The application
owns it and may share it across PDFs. Close each PDF first, then close the provider
after all borrowers finish. Importing a package does not start a worker or download a model.

`auto` recognizes embedded image regions, including images on pages that already have
native text. Geometry and normalized content suppress duplicate hidden OCR layers while
preserving distinct repeated placements. A scan (an image over half the page) under a text
layer of 20 or more words, whose lines run down a fifth of it or more, is judged by how
cleanly the layer reads: 85% or more of its words reading as words, numbers or codes skips
recognition; a poorer layer is recognized again, and when the recognized words read at least
10 points cleaner (and number at least half as many), they replace the layer within the scan.
Smaller images are skipped when native text covers 30% of their area (backgrounds,
watermarks), as are images too small to hold a letter. A page without native text that is
drawn with many vector shapes (outlined lettering) is rendered and recognized. `always`
recognizes bounded page rasters; `off` uses only native text. Complex layouts and
arbitrary-document OCR accuracy are not guaranteed.

Page renders target 300 DPI, and image regions shown below 200 DPI are enlarged toward
300 DPI, within `limits.maxOcrPixels`. Recognized words below `minOcrConfidence` (default
0.3; `0` keeps every word) are dropped, which removes most noise from photos and graphics:

```ts
const text = await pdf.getStructuredText({ ocr: 'auto', minOcrConfidence: 0.5 });
```

On pages larger than any paper (over 17 in, as image-to-PDF tools make from scans), an image
whose recognition finds no words is read once more without enlargement, the recognizer
estimating its resolution. A page that still has no text at all (handwriting, forms, faint
scans) has its images read again as scattered words.

## Custom OCR providers

Core accepts any {@link "@pdfextract/core".OcrProvider}. It passes tightly packed RGBA8
rasters ({@link "@pdfextract/core".OcrRaster}) with their effective resolution in `dpi` when
known, and `layout: 'sparse'` when it asks for scattered words; a provider may use both or
ignore them. Words come back in raster pixels with a confidence in [0, 1], and core maps
them onto the page. A provider that reports `concurrency` above one gets that many pages at
once during OCR.

## Browser asset layout

Copy the complete `dist/assets` trees from the installed core and OCR packages,
including sibling codecs/fonts/notices. Host separately supplied language models as
`languages/eng.traineddata.gz`, and optionally `deu.traineddata.gz`, with their notices:

```text
pdfextract/
  core/          # pdf.mjs, pdf.worker.mjs, png.mjs, wasm/, iccs/, fonts and CMaps
  ocr/           # tesseract.mjs, worker.min.js, core/ with LSTM JS/WASM variants
  languages/     # traineddata.gz files and license information
```

In this repository, `pnpm assets` prepares that layout for the browser example.
This typechecked browser example accepts the base URL of the hosted directory:

{@includeCode ../examples/ocr.ts}

Serve JavaScript as `text/javascript` and WASM as `application/wasm`. Serve
`.traineddata.gz` as gzip-file bytes; do not label already compressed files with an HTTP
`Content-Encoding: gzip` header that would decompress them before Tesseract reads them.
Cross-origin asset servers need appropriate CORS. Keep URLs under your application's
non-root base when applicable.

CSP must permit same-origin scripts/module workers, fetching model/codec assets and
WASM compilation (`'wasm-unsafe-eval'` where supported). The provider uses direct worker
URLs; it does not require a mandatory CDN, hosted extraction service or cross-origin
isolation headers. Use a single trusted asset origin where practical.

The same asset configuration works inside a dedicated **module** Web Worker
(`new Worker(url, { type: 'module' })`). There, core starts the PDF.js worker as a nested
worker and renders full-page OCR (`ocr: 'always'`) with `OffscreenCanvas`; SVG-based
transfer-function filters are skipped, as in Node. Pass bytes (`ArrayBuffer`) or a `File`
to the worker.

## Node assets and failures

Node resolves packaged engine/worker assets automatically through the packages' `node`
export condition. Supply `assets.languageDataBaseUrl` as a filesystem path or `file:` URL.
An optional `coreBaseUrl` can identify a different Tesseract core directory. Use Node's default OCR
worker rather than the browser `worker.min.js` override shown above.

Worker concurrency defaults to half the logical processors (at least one, at most four)
and is bounded from one to eight. With more than one worker, core reads that many pages at
a time during OCR, so their recognition overlaps: an
8-page scan took 16.5 s with one worker and 6.5 s with four, with the same text. Each worker
holds its own Tesseract instance and the page rasters in flight, so memory grows with it;
set `concurrency: 1` where memory is tight. Workers start on first use, and a further one only
when recognitions overlap: a document read one raster at a time uses one worker. The Tesseract
provider consumes tightly packed RGBA8 and returns word/line boxes in the supplied
raster pixels. Core maps them back into page coordinates. Missing/broken assets reject
with `OCR_ASSET_UNAVAILABLE`; recognition failures use `OCR_FAILED`. Collect mode preserves
failed regions as partial results, even when another region succeeds.

Only Node full-page OCR (`always`) and composite image export (`composite: true`) need
the native canvas addon. It is an optional peer dependency of core and is not installed
automatically: run `npm install @napi-rs/canvas` to enable them, otherwise full-page OCR
rejects with `OCR_ASSET_UNAVAILABLE` and composites with `UNSUPPORTED_IMAGE_FEATURE`.
Native text, exact embedded-image exports and automatic image-region OCR never load it.
Browsers and Web Workers use their built-in canvas.

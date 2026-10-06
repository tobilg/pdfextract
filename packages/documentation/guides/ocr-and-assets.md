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
preserving distinct repeated placements. `always` recognizes bounded page rasters; `off`
uses only native text. Complex layouts and arbitrary-document OCR accuracy are not guaranteed.

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

Worker concurrency defaults to one and is bounded from one to eight. The Tesseract
provider consumes tightly packed RGBA8 and returns word/line boxes in the supplied
raster pixels. Core maps them back into page coordinates. Missing/broken assets reject
with `OCR_ASSET_UNAVAILABLE`; recognition failures use `OCR_FAILED`. Collect mode preserves
failed regions as partial results, even when another region succeeds.

Only Node full-page OCR (`always`) needs the native canvas addon. It is an optional peer
dependency of core and is not installed automatically: run `npm install @napi-rs/canvas`
to enable that mode, otherwise it rejects with `OCR_ASSET_UNAVAILABLE`. Native text,
embedded-image exports and automatic image-region OCR never load it. Browsers and Web
Workers use their built-in canvas.

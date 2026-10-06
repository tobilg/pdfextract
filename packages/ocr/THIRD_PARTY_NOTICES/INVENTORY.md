# Third-party notices: @pdfextract/ocr

`@pdfextract/ocr` is MIT-licensed (see `LICENSE`). It ships the following third-party
components, which keep their own licenses. License texts are in this directory; keep them
when self-hosting the files in `dist/assets`.

## JavaScript

| Component | License | Notice | Use |
| --- | --- | --- | --- |
| Tesseract.js 7.0.0 | Apache-2.0 | `TESSERACT-JS-LICENSE` | Patched controller (`tesseract.mjs`, `tesseract-node.cjs`), Node worker (`node-worker.cjs`) and upstream browser worker (`worker.min.js`) |
| bmp-js 0.1.0 | MIT | `bmp-js-LICENSE` | Bundled Tesseract.js worker dependency |
| idb-keyval 6.3.0 | Apache-2.0 | `idb-keyval-LICENSE` | Bundled in upstream `worker.min.js` (model cache, disabled by this package) |
| is-url 1.2.4 | MIT | `is-url-LICENSE` | Bundled Tesseract.js dependency |
| regenerator-runtime 0.13.11 | MIT | `regenerator-runtime-LICENSE` | Bundled Tesseract.js dependency |
| wasm-feature-detect 1.9.0 | Apache-2.0 | `wasm-feature-detect-LICENSE` | Bundled SIMD/relaxed-SIMD core selection |
| zlibjs 0.3.1 | MIT | `zlibjs-LICENSE` | Bundled in upstream `worker.min.js` (model decompression) |
| fast-png 6.4.0, iobuffer, pako | MIT, MIT, MIT AND Zlib | `fast-png-LICENSE`, `iobuffer-LICENSE`, `pako-LICENSE` | Runtime dependency used to encode rasters for Tesseract |

## WebAssembly OCR engine

`dist/assets/core` contains the LSTM-only builds (baseline, SIMD and relaxed-SIMD) of
tesseract.js-core 7.0.0 (Apache-2.0, `TESSERACT-JS-CORE-LICENSE`), compiled from:

| Component | License | Notice |
| --- | --- | --- |
| Tesseract | Apache-2.0 | `tesseract-LICENSE` |
| Leptonica | BSD-2-Clause | `leptonica-LICENSE` |
| IJG libjpeg | IJG license (this software is based in part on the work of the Independent JPEG Group) | `libjpeg-LICENSE` |
| libpng | libpng license | `libpng-LICENSE` |
| libtiff | libtiff license | `libtiff-LICENSE` |
| libwebp | BSD-3-Clause | `libwebp-LICENSE` |
| zlib | Zlib | `zlib-LICENSE` |
| giflib | MIT | `giflib-LICENSE` |
| OpenLibm | MIT/ISC/BSD, per file | `openlibm-LICENSE` |

## Language models (not shipped)

Language models are supplied by the caller. The Tesseract `tessdata` 4.0.0 models are
Apache-2.0 ([COPYING](https://github.com/tesseract-ocr/tessdata/blob/4.0.0/COPYING));
host their notice alongside the models.

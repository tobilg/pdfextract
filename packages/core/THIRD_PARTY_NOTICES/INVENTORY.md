# Third-party notices: @pdfextract/core

`@pdfextract/core` is MIT-licensed (see `LICENSE`). It ships the following third-party
components, which keep their own licenses. License texts are in this directory and beside
the copied engine assets in `dist/assets`; keep them when self-hosting those assets.

| Component | License | Notice | Use |
| --- | --- | --- | --- |
| PDF.js 5.1.91 (`pdfjs-dist`) | Apache-2.0 | `PDFJS-LICENSE` | `dist/assets/pdf.mjs` and the patched `pdf.worker.mjs` |
| OpenJPEG WASM | BSD-2-Clause; Apache-2.0 PDF.js wrapper | `dist/assets/wasm/LICENSE_OPENJPEG`, `LICENSE_PDFJS_OPENJPEG` | JPEG 2000 (JPX) decoding |
| qcms WASM | MIT; Apache-2.0 PDF.js wrapper | `dist/assets/wasm/LICENSE_QCMS`, `LICENSE_PDFJS_QCMS` | ICC/CMYK color conversion |
| Adobe CMaps | BSD-style Adobe notice | `dist/assets/cmaps/LICENSE` | CJK and other font mappings |
| Foxit standard fonts | BSD-3-Clause | `dist/assets/standard_fonts/LICENSE_FOXIT` | Substitutes for the 14 standard PDF fonts |
| Liberation fonts | SIL OFL-1.1 | `dist/assets/standard_fonts/LICENSE_LIBERATION` | Substitutes for the 14 standard PDF fonts |
| Compact ICC profiles | CC0-1.0 | `dist/assets/iccs/LICENSE` | CMYK runtime profile |
| fast-png 6.4.0, iobuffer, pako | MIT, MIT, MIT AND Zlib | `fast-png-LICENSE`, `iobuffer-LICENSE`, `pako-LICENSE` | Bundled into the PNG encoder `dist/assets/png.mjs`; fast-png is also a runtime dependency |

## Optional peer dependency (not shipped)

`@napi-rs/canvas` (MIT; bundles the BSD-3-Clause Skia library and its components) is an
optional peer dependency used only for full-page OCR (`ocr: 'always'`) in Node. It is not
included in or installed with this package; consumers who install it receive it under
its own license terms.

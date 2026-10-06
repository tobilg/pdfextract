# Dependency and asset licenses

The existing repository MIT file is preserved. It is **not** treated as owner approval
for these new packages: all three use `UNLICENSED` pending the owner's release decision.
This has no effect on local builds/tests. Do not publish before resolving that decision.

`dependency-licenses.json` records installed npm versions and package license declarations.
`upstream-commits.txt` records source submodules, including the native OCR engine/codecs.
Regenerate with `node scripts/notices.mjs`. A wrapper license alone is not our evidence.

| Component | Actual license / source evidence | Use |
| --- | --- | --- |
| PDF.js 5.1.91 | Apache-2.0; `vendor/pdfjs/LICENSE` | Pinned display/parser worker, with documented extension |
| PDF.js OpenJPEG WASM | OpenJPEG BSD-2-Clause; Apache-2.0 wrapper; `dist/assets/wasm/LICENSE_OPENJPEG`, `LICENSE_PDFJS_OPENJPEG` | JPX decoder |
| PDF.js qcms WASM | MIT; Apache-2.0 wrapper; `LICENSE_QCMS`, `LICENSE_PDFJS_QCMS` alongside WASM | ICC/CMYK conversion |
| PDF.js CMaps | Adobe BSD-style redistribution notice in `dist/assets/cmaps/LICENSE` | Font mappings |
| Foxit standard fonts | BSD-3-Clause, `standard_fonts/LICENSE_FOXIT` | Standard PDF fonts |
| Liberation standard fonts | SIL OFL-1.1, `standard_fonts/LICENSE_LIBERATION` | Standard PDF fonts; no renaming/modification |
| Compact ICC profiles | CC0-1.0; `vendor/icc-profiles/license`, PDF.js `iccs/LICENSE` | CMYK runtime profile and sRGB/DisplayP3 fixtures |
| fast-png 6.4.0 / iobuffer / pako | MIT / MIT / (MIT AND Zlib); notices copied with PNG bundle | PNG encoding, lossless tests |
| Tesseract.js 7.0.0 | Apache-2.0; upstream LICENSE.md | Lazy OCR controller/worker |
| tesseract.js-core 7.0.0 | Apache-2.0 wrapper; native licenses below | WASM, SIMD/relaxed-SIMD variants shipped together |
| Native Tesseract | Apache-2.0; pinned `third_party/tesseract/LICENSE` | OCR engine |
| Leptonica | BSD-2-Clause; `leptonica-license.txt` | OCR image processing |
| IJG libjpeg | IJG permissive license in README, including acknowledgment conditions | OCR JPEG codec; software based in part on the work of the Independent JPEG Group |
| libpng | libpng license (libpng-2.0 text in selected source) | OCR PNG codec |
| libtiff | libtiff permissive copyright/license in COPYRIGHT | OCR TIFF codec |
| libwebp | BSD-3-Clause; COPYING | OCR WebP codec |
| zlib / giflib | Zlib / MIT; README / COPYING | OCR compression/GIF |
| OpenLibm | MIT/ISC/BSD notices collected in LICENSE.md, with per-file provenance | WASM math |
| English/German traineddata | Apache-2.0 for Tesseract tessdata 4.0.0; npm data wrappers are MIT | Separately supplied models, not in our tarballs |
| @aws-sdk/client-s3 3.1146.0 and Smithy dependencies | Apache-2.0; installed SDK notices | Caller-owned optional peer |
| S3rver 3.7.1 | MIT; `vendor/s3rver/LICENSE` | Default local service in tests; **no MinIO/AGPL service** |
| @napi-rs/canvas 0.1.80 | MIT wrapper; native Skia and Rust components below | Optional Node page OCR rasterizer; fixture text generation |
| EmbedPDF PDFium 2.15.1 | Published package MIT; PDFium BSD-3-Clause and component notices in `LICENSE.pdfium` | Feasibility spike only, not shipped in core |
| TypeScript / Vite / Vitest / Playwright / Biome | Apache-2.0 / MIT / MIT / Apache-2.0 / MIT OR Apache-2.0 | Development tools, exact versions in lockfile |
| TypeDoc 0.28.20 | Apache-2.0, installed package license | Private static documentation generation; supports TypeScript 6 |
| Wrangler 4.147.0 / Miniflare 5.20261001.0-alpha / workerd 1.20261001.1 | MIT OR Apache-2.0 / MIT / Apache-2.0, installed packages | Private website development/deployment tooling; excluded from library runtime dependencies |

## Native canvas dependency

The selected canvas source tag and its Skia gitlink are pinned under `vendor/canvas`.
`scripts/build-skia.js`, `skia/DEPS`, `skia/BUILD.gn`, and `Cargo.toml` provide the build
evidence. Skia is BSD-3-Clause. Its enabled CPU/font/image components include Expat
(MIT), HarfBuzz (MIT), ICU (Unicode license), FreeType (FTL, the permissive alternative),
libjpeg-turbo (IJG/BSD-3-Clause/Zlib), libpng (libpng), libwebp (BSD-3-Clause), zlib
(Zlib), Wuffs (Apache-2.0 OR MIT), WOFF2 and Brotli (MIT), JPEG XL and Highway
(BSD-3-Clause). Rust libavif/libavif-sys use BSD-2-Clause native libavif and BSD-2-Clause
AOM codecs (including their patent grant); mimalloc uses MIT. The other Rust crates
in Cargo.toml are MIT/Apache-2.0 or permissive equivalents (nom is MIT).

The `skia_use_libheif` flag refers to the Android framework interface, not
strukturag/libheif or x265: Skia's BUILD.gn explicitly has no external HEIF dependency
for our macOS/Linux targets. No AGPL codec is required here.

**Native binary provenance limit:** upstream 0.1.80 does not provide a Cargo.lock or
a per-platform build SBOM in its npm artifact/source tag. The exact Rust dependency
revisions of its prebuilt binary cannot be reconstructed from that tag alone.
The licenses above identify the source components/build choices; they are not a claim
of a complete reproducible binary SBOM. Before release, obtain the producer's SBOM
and complete native notices, or build the optional addon from a locked, audited source
tree. Native text, image inventory/export and automatic embedded-image OCR do not
use this addon; Node `ocr: 'always'` does. It remains an explicit release evidence gap.

## Models, references and fixtures

Models are copied from `@tesseract.js-data/eng@1.0.0` and `deu@1.0.0`, `4.0.0/*.traineddata.gz`.
The underlying data license is from [Tesseract tessdata 4.0.0 COPYING](https://github.com/tesseract-ocr/tessdata/blob/4.0.0/COPYING),
not inferred from the npm wrapper's MIT metadata. Host model notices alongside them.
Generated PDFs and pixel expectations are project fixtures; the owner package license
decision also applies to that new project-authored material. Profiles retain CC0.
LittleCMS 2.19 (MIT), libtiff and OpenJPEG are optional reference/fixture tools, not runtime dependencies.

No AGPL declaration occurs in the installed npm inventory. `humanize-number@0.0.2`
and `only@0.0.2` have MIT license text in their README despite incomplete npm metadata.
Distribution notices are included under each package's `THIRD_PARTY_NOTICES` and
beside copied engine assets. Keep those files when self-hosting assets.

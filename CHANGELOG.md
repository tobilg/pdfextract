# Changelog

All notable changes to the `@pdfextract/*` packages are documented here. The packages are
released together with one version. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (before 1.0.0, a minor version may
contain breaking changes).

## [0.3.0] - 2026-10-18

### Added

- Table detection in `getStructuredText`, on by default (`tables: false` turns it off). Tables
  are found from ruling lines (`detection: 'ruled'`, including merged cells) and from aligned
  text columns (`detection: 'aligned'`), returned in each page's `tables` and read row by row,
  with tab-separated cells, in the text. Each table's text block carries a `tableIndex`.
- Composite image export: `extractImage(id, { composite: true })`, or `openPdf(input,
  { composite: true })` as the default, renders an image together with everything the page
  draws above it, cropped to the image. `annotations: true` includes annotation appearances,
  and `scale` sets the render resolution. `ExtractedImage.composited` reports `'none'` (the
  exact stored pixels), `'above'` or `'page'` (the image's own draw could not be isolated).
  Images that full exports reject because of an unsupported graphics state are rendered too.
- `ImageOccurrence.overlaid`: whether the page draws something visible above a placement.
  `getImages({ annotations: true })` counts annotations too.
- `ImageList.warnings`: `IMAGE_INVENTORY_DEGRADED` for selected pages whose content had to be
  read leniently; OCR `auto` adds the same warning to affected text pages.
- `PdfLimits.maxCachedRuleLines` (default 200,000, about 8 MB) bounds the ruling lines kept
  for table detection.
- A `TABLE_DETECTION_DEGRADED` page warning when ruling lines are unavailable or the page
  draws more lines than are scanned.

### Changed

- **Breaking:** `TextPage.tables`, `ExtractedImage.composited` and `ImageOccurrence.overlaid`
  are new required fields. Code that constructs these types (for example test doubles) must
  set them. `schemaVersion` stays `1`.
- **Breaking:** because table detection is on by default, `fullText` and `blocks` change on
  pages with tables: each table becomes one block with one tab-separated line per row. Rows
  of undetected tables also stay on one line, with tabs between widely separated fragments.
- Page rendering in Node (full-page OCR and composite export) needs the optional
  `@napi-rs/canvas` peer dependency; the error message now names both uses.
- `openPdf` fails with a clear message when the bundled engine lacks an internal the
  extraction relies on; the build checks the same internals.
- With `errorMode: 'collect'`, a page whose native text extraction fails is still covered by
  OCR (when enabled) instead of skipping it.

### Fixed

- `overlaid` no longer marks images that a gradient elsewhere on the page, clipped-away
  content or a frame drawn around the image would have marked, and text extents match text
  extraction.
- A broken text or graphics operator (such as text shown before any font is set) no longer
  makes `getImages`, `extractImage` and OCR `auto` fail for the whole document: the page is read
  leniently and reported. Composites and full-page OCR render pages leniently, so such errors
  no longer leave them blank; text extraction still reports them.
- Text extents for `overlaid` follow each font's own glyph units (Type3 and some CFF fonts)
  and vertical writing.
- `ImageOccurrence.clipped` is only true when a clip cuts into the image. A page-wide clip or a
  Form XObject that contains the image no longer marks it, so composite exports of such images
  keep the exact stored pixels. Text clips now count.
- `scale` accepts fractional factors, and any value other than 1 renders the composite
  instead of being ignored for images with nothing above them.
- Text drawn below an image with a clipping text mode still clips the composite.
- Composite exports match the image's draw by placement and raster size, so a different
  raster drawn at the same position cannot be mistaken for it, and clean up the page even
  when rendering fails.
- Tables are not reported for chart grids, sparse forms or bulleted lists, while tables with
  numbered rows and ruled tables side by side are kept. White or clipped-away lines are not
  ruling lines, and detection thresholds scale with the size of the text being measured, so
  fine-print tables are found on pages of body text.
- Table detection no longer scans the vector graphics of pages without table-like text (for
  example a page whose only split row is a header with a page number). Ruling lines of
  scanned pages are cached compactly within a fixed budget, and listing images no longer
  collects them.
- Exporting several images from one page builds the page's drawing instructions once instead
  of once per image (about 6× faster for 20 images on a text-heavy page). Decoding an inline
  image releases that cache, so no decoded pixels stay in memory.
- OCR `auto` with `pages` only scans the selected pages' images instead of the whole
  document's inventory.
- `images` progress is consistent: `getImages` reports every requested page and OCR `auto`
  every selected page on each call, cached or not; pages scanned only to complete the
  inventory are reported when they are scanned.
- A failed ruling-line scan is reported with `UNSUPPORTED_PDF_FEATURE` in the
  `TABLE_DETECTION_DEGRADED` warning instead of an image error code.

## [0.2.0] - 2026-10-08

0.1.0 was not tagged in the repository, so this release has no compare link.

### Added

- Image size filtering: `getImages({ minWidth, minHeight })` leaves out smaller images,
  measured as exported, and reports them in the returned list's `ignoredCount`.
  `getImages` now returns an `ImageList`.
- Orientation of placed images: `ImageOccurrence.originalOrientation` describes how the
  stored raster is mirrored or rotated relative to its placement. `extractImage` takes an
  `occurrenceId` to choose the placement and `preserveOrientation` to keep the stored
  orientation.
- The Node and browser examples and the demo can skip small images.
- Links to the live demo and the API documentation site; package homepages point to it.

### Changed

- **Breaking:** `extractImage` exports images oriented as their placement shows them on the
  page (mirroring and quarter turns corrected losslessly). Quarter-turn placements swap
  `width` and `height`. Pass `preserveOrientation: true` for the previous output.

### Fixed

- Release publishing uses npm trusted publishing with the npm bundled in Node 24.

## [0.1.0] - 2026-10-06

Initial release.

### Added

- `@pdfextract/core`: `openPdf` for whole PDFs from a `Blob`, `ArrayBuffer` or
  `Uint8Array` in browsers, Web Workers and Node.js ≥22.12.0, with a self-hosted, patched
  PDF.js engine. Structured text with coordinates (spans, lines, blocks) and deterministic
  reading order, an embedded-image inventory with placements, lossless PNG export and
  bounded thumbnails, password support, resource limits, cancellation, progress events and
  typed `PdfExtractError` codes.
- `@pdfextract/ocr`: `createTesseractOcr`, a lazy, self-hosted Tesseract.js provider for
  `auto` (image regions) and `always` (whole page) OCR. No CDN or implicit model downloads.
- `@pdfextract/storage`: filesystem (Node) and S3 adapters with `put`, `get`, `head` and
  `delete` that preserve bytes.
- Node and browser examples, the documentation site and the in-browser demo.

[0.3.0]: https://github.com/tobilg/pdfextract/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/tobilg/pdfextract/releases/tag/v0.2.0
[0.1.0]: https://www.npmjs.com/package/@pdfextract/core/v/0.1.0

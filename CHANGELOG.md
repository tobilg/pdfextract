# Changelog

All notable changes to the `@pdfextract/*` packages are documented here. The packages are
released together with one version. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (before 1.0.0, a minor version may
contain breaking changes).

## [0.4.0] - 2026-11-10

Extraction quality on two public benchmarks, measured with the repository's harness
(`benchmarks/`) and liteparse 2.18.0 as the reference. 0.3.0 has no Markdown, math or header
detection and is scored on its `fullText`; 0.4.0 on `toMarkdown` output (for olmOCR-bench
with `math: 'latex'` and running headers and footers left out):

| Benchmark | 0.3.0 | 0.4.0 | liteparse |
| --- | --- | --- | --- |
| olmOCR-bench | 22.9% | 61.8% | 45.3% |
| olmOCR-bench `multi_column` (reading order) | 12.2% | 73.1% | 63.2% |
| olmOCR-bench `long_tiny_text` | 24.7% | 76.2% | 26.7% |
| opendataloader-bench | 0.572 | 0.923 | 0.895 |
| opendataloader-bench reading order (NID) | 0.862 | 0.952 | 0.925 |

### Added

- Markdown output: `toMarkdown(result)` writes headings as `#` lines, detected tables as pipe
  tables (HTML tables where cells merge: `rowspan`/`colspan`, header rows and the first column
  as `th`; `tables: 'pipe' | 'html'` chooses one syntax) and other blocks as paragraphs, with
  pages separated by a thematic break (`pageSeparator` changes it). A paragraph is one line:
  its lines are joined and words hyphenated at a line end rejoined (the hyphen stays after a
  capital, before one, and in words the document writes with a hyphen elsewhere), and an
  inline formula broken at a line end is joined again. Tab-separated rows, list items and
  displayed math keep their own lines, and a block of rules typed as text (underscores,
  dashes) is a thematic break. `lines: 'preserve'` keeps the page's lines; `furniture: false`
  leaves running headers and footers out (by default they are kept, as in the text).
- Heading detection: `TextBlock.headingLevel` (1 for the largest type on the page) marks short
  lines set larger than the page's body text, or bold where it is not, and a line that only
  names a conventional section ("Contents", "References", "Appendix A") and opens its block.
  Body type is measured over all text, tables included. Running headers and footers, leaders,
  numbered captions ("Table 2:"), dates, links, numbers, lines with tab-separated parts
  (contents entries, table rows) and lines within a sentence of body text are not headings.
- `math: 'latex'`: on pages typeset with TeX, formulas are rebuilt from their glyphs and
  written into the text as `$…$` LaTeX. Math fonts (Computer Modern, AMS, Latin Modern, tx/px,
  newtx, Euler, rsfs, mathabx, and OpenType math fonts such as STIX Two Math, Libertinus Math
  and Cambria Math), TeX's encodings (OML, OMS, OMX) and Unicode math letters (𝑥, 𝐇, ℝ, read
  in their alphabet: `\mathbf`, `\boldsymbol`, `\mathbb`, …) give the symbols; glyph size and
  baseline the sub- and superscripts; thin rules the fractions, roots and overlines (also
  rules drawn as stretched 1×1 image masks); centred script rows the limits of large
  operators. Operator names next to math (`2\cos 2\pi`) and upright words in formulas
  (`\operatorname{diam}(T)`) are math too, as are formulas of three glyphs or more without
  scripts (`x \in X`); one glyph alone stays text, and formulas that touch on a line are one.
  Text around a formula keeps its own spans. Pages without TeX math fonts are unaffected; the
  default `text` keeps the glyphs' Unicode. The approach follows liteparse's TeX math pass;
  the implementation is independent.
- Page furniture: `TextBlock.furniture` marks running headers and footers (`'header'`,
  `'footer'`): short blocks in the top or bottom 15% of a page set apart from the text, page
  numbers there (`8 | Page` too), full-width lines there that cite the publication (volume and
  issue, DOI, ISSN, a copyright, download or citation notice, a court filing's case line),
  and text repeated at the same height across the extracted pages. Text set at a quarter turn
  in the outer tenth of the width is a `'margin'` stamp. Prose, sentences at the body size,
  paragraphs continued from the previous page, captions, equation numbers, footnotes and
  headings near an edge are not marked. The blocks stay in the text.
- Line numbers printed beside the text (a manuscript's numbered lines in its margins, a
  patent's 5, 10, 15 in the gutter, also as a scan's text layer misreads them: `1O`) are left
  out of it: vertical runs of number-only spans counting up in one step (1, 5 or 10; lines
  may be skipped) at one line pitch, with running text next to most of them. A table's column
  of row numbers beside short cells or figures stays.
- `StructuredTextOptions.minOcrConfidence` (default 0.3): recognized words below this
  confidence are dropped, which removes most noise from photos and graphics.
- `OcrRaster.dpi` (the raster's effective resolution, which the Tesseract provider passes on),
  `OcrRaster.layout: 'sparse'` (scattered words, which the Tesseract provider reads in
  sparse-text mode, PSM 11) and `OcrProvider.concurrency` (rasters a provider recognizes at
  once; core reads that many pages together during OCR).
- A benchmark harness for contributors: `pnpm bench odl` and `pnpm bench olmocr` run
  opendataloader-bench and olmOCR-bench at pinned revisions with their own scorers and compare
  with committed baselines of pdfextract and liteparse (see `benchmarks/README.md`).
- Documentation: a "Text and Markdown" guide (reading order, headings, running headers and
  footers, Markdown rendering, LaTeX math) with a typechecked example, and custom OCR
  providers in the OCR guide.
- Demo: a Markdown view of each page with the Markdown options and a Markdown download,
  **Write TeX formulas as LaTeX**, a minimum OCR word confidence, and headings and running
  headers, footers and margin stamps marked in the structure view and counted in the summary.

### Changed

- **Breaking:** `fullText` and `blocks` change on most pages: the reading order, paragraphs
  (lines side by side without horizontal overlap are separate paragraphs), headings (blocks of
  their own), line numbers (left out) and the text of native runs (below) all change.
  `schemaVersion` stays `1`.
- **Breaking:** `TextSpan.fontName` is the PDF font name without a subset prefix (for example
  `Helvetica-Bold`) when available, not the engine's generic family.
- **Breaking:** OCR drops recognized words below 0.3 confidence by default
  (`minOcrConfidence: 0` keeps them all). The Tesseract provider's `concurrency` defaults to
  half the logical processors, one to four (was one); a raster goes to the least busy worker,
  a started one first, so further workers start only for overlapping work. Set
  `concurrency: 1` to keep memory to one worker.
- Reading order uses a recursive XY-cut: columns are read one after another, and a heading,
  header or caption across the gutter no longer merges the columns beside it. A gutter is
  followed through the rows it runs through, so columns below a title, beside a sidebar or
  starting at different heights are found too; it continues past a skewed scan's drift and
  around a figure set between the columns, whose caption is read after the left column.
  Narrow gutters (down to 6 pt, 0.75 line heights, as in compact journals) split running text,
  newspaper columns of about 20 characters a line included, and display lettering beside it;
  in a scan's text layer, whose word gaps can be as wide as a gutter, only where they run
  through six lines. A gutter through some rows needs running text on one side or words on
  both, so a chart's labels read row by row. Tables take their place as single units. The last
  line of a wrapped heading stays with it, a line read in parts is not split into columns, and
  a paragraph cut at a region's edge rejoins when its sentence goes on.
- Native text: runs get the width PDF.js measures along their baseline (text scaled
  differently along and across it, by horizontal scaling or a Type 3 font's matrix, had boxes
  too narrow or too wide by that ratio, up to a hundredth of the word). A space of its own
  between two runs (a scan's layer writing each word apart) is a word break when it fits the
  gap. Accents drawn as glyphs of their own join their letters (Gr¨obner reads Gröbner, Sa˜o
  reads São), whether drawn before the letter (TeX) or after it. Letter-spaced runs
  (A R T I C L E I N F O) are read again from their glyphs, which now include invisible text (a
  scan's OCR layer, left out of math). A text row is joined by its widest run, so a raised
  accent or a Symbol-font letter no longer starts a row of its own.
- OCR: the Tesseract provider uses automatic page segmentation (PSM 3) instead of the
  library's single-block default, passes the raster's DPI and recognizes a grayscale copy
  (colored text was lost to per-channel thresholding). Page renders target 300 DPI (was up to
  144), and image regions shown below 200 DPI are enlarged toward 300 DPI within
  `maxOcrPixels`. OCR words keep the lines the recognizer found and take their line's top and
  bottom, and are not added where they misread overlapping native text.
- OCR `auto` also renders a page that has no native text but is drawn with many vector shapes
  (outlined lettering); skips images that native text covers by 30% or more of their area
  (backgrounds, watermarks, scans under their own text layer); judges a scan's own text layer
  by how cleanly it reads, skipping recognition for a clean layer and replacing a poor one
  within the scan where the new words read clearly better (a citation stamped at a scan's foot
  is no layer); reads an image on a page larger than any paper (over 17 in) again without
  enlargement and DPI when it yields no words; and reads a page that still has no text as
  scattered words (`layout: 'sparse'`).
- Table detection finds more tables: grids of shaded cells, striped rows and colored headers
  (a second pass over the edges of filled areas), borders drawn as mitred bars or as one
  filled ring, tables ruled with horizontal lines only (booktabs, including sparse columns and
  lines of short cells), one-column lists drawn as boxes, fill-in worksheets, two-row figure
  grids and two-column lists of short entries. Pages that draw at least four lines are checked
  even when their text does not suggest a table; their ruling lines come from the same worker
  pass that reads fonts.
- Tables are read more finely: a ruled table whose text aligns into more columns than its
  rules draw takes the finer grid; ruled cells over several rows or columns whose text lies
  level with their own rows or within one column each are split; empty grid rows and columns
  are removed; native runs written across a column rule are split there. Aligned tables take
  their columns from the data rows (headers over several columns become merged cells), go on
  past rows that label the rows below (`Teachers by degree:`), start anew at a "Table N"
  caption, and keep the words of a scan layer set a word per span in their cells. Tables of
  contents (ascending page numbers, Roman ones too), running text or a justified box between
  two rules, and rotated margin stamps are no tables; a column of values with units
  (3 days 5 hours) is no prose column.

### Performance

- Node: an engine worker that served a document and closed cleanly serves the next one (up to
  two wait idle, each serves at most 100 documents; failures end the worker), and one is
  started ahead while a document is read, without keeping the process alive. Its compiled
  code stays warm: native text extraction of small documents takes about a third of the time
  (opendataloader-bench: 45 → 12 ms per document), with identical output.
- OCR `auto` skips images too small to hold a letter (under 4 pixels or 3 pt either way): a
  page of TeX math drawing its rules as thousands of 1×1 masks took minutes, now a fraction of
  a second.
- OCR: with a provider that recognizes several rasters at once (`OcrProvider.concurrency`),
  core reads that many pages at a time, so their recognition overlaps; output and errors are
  as page by page. An 8-page scan: 16.5 s with one worker, 6.5 s with four.
- OCR: enlarged rasters stop at 9 million pixels (a letter page at 300 DPI); more cost
  recognition time without reading better. `maxOcrPixels` still bounds all rasters. The
  Tesseract provider passes rasters as binary PNM, which its image library reads as is,
  instead of compressing a PNG that it then decompresses.
- `math: 'latex'` finds the span owning each glyph through an index of spans by height band:
  math pages take 35% less time than with a scan of all spans.
- Scans of a page no longer compile glyph outlines and post them to the main thread, which
  PDF.js does for every shown string when font faces are disabled (as in Node); renders still
  get them. Text extraction of a typical page is about 20% faster. Engine assets (color
  management) are read once per process, not per document.

### Fixed

- Text in a font PDF.js reports NaN ascent or descent for (arXiv's rotated margin stamp, for
  example) got NaN boxes (`null` in JSON). Such fonts now use typical metrics.
- OCR `auto` no longer skips an image larger than `maxOcrPixels` (`RESOURCE_LIMIT_EXCEEDED`,
  an empty page for most full-size scans, and for anything above 4 MP in the demo); it is
  reduced to fit the budget by area average, as page renders already were.

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

[0.4.0]: https://github.com/tobilg/pdfextract/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/tobilg/pdfextract/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/tobilg/pdfextract/releases/tag/v0.2.0
[0.1.0]: https://www.npmjs.com/package/@pdfextract/core/v/0.1.0

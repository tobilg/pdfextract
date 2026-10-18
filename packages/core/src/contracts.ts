/** Whole PDF bytes or a browser Blob/File. Node Buffer is accepted as Uint8Array; opening copies caller bytes. */
export type PdfInput = Blob | ArrayBuffer | Uint8Array;
/** Opaque, document-scoped appearance identifier. Persist its association in a manifest, not across reopened PDFs. */
export type ImageId = string;
/** Recognition policy: off uses native text, auto recognizes embedded image regions, always recognizes bounded full pages. */
export type OcrMode = 'off' | 'auto' | 'always';

/** Cancellation and synchronous progress notifications for a single extraction or recognition operation. */
export interface OperationOptions {
  /** Aborts queued work promptly; a synchronous engine decode already running may finish before cleanup. */
  signal?: AbortSignal;
  /** Called during work. Keep callbacks lightweight and avoid throwing. */
  onProgress?: (event: ProgressEvent) => void;
}

/** Progress within one extraction stage; totals and counters are not a document-wide percentage. */
export interface ProgressEvent {
  /**
   * Current operation phase. `images` covers the image inventory: `getImages` reports every
   * requested page (all pages without `pages`) on every call, and OCR `auto` every selected page,
   * whether the page is scanned now or already known; other pages are reported only when they
   * are scanned to complete the document's inventory (as `extractImage` does on first use).
   */
  stage: 'open' | 'text' | 'images' | 'ocr' | 'export';
  /** Completed units in this stage. */
  completed: number;
  /** Total units when known; absent when the amount of work is unknown. */
  total?: number;
  /** Unit of the completed/total counters. */
  unit: 'pages' | 'images' | 'tasks' | 'bytes';
  /** Affected one-based page number, when available. */
  pageNumber?: number;
  /** Affected document-scoped image identifier, when available. */
  imageId?: ImageId;
}

/** Positive safe-integer resource budgets. Unspecified values use DEFAULT_LIMITS; memory is an estimate, not an OS sandbox. */
export interface PdfLimits {
  /** Maximum whole-PDF input length in bytes; default 256 MiB. */
  maxInputBytes?: number;
  /** Maximum PDF page count; default 10,000. */
  maxPages?: number;
  /** Maximum native image width × height; default 64 million pixels. */
  maxImagePixels?: number;
  /** Estimated decoded working-memory budget; default 1 GiB, estimated at 16 bytes per pixel. */
  maxDecodedBytes?: number;
  /** Maximum pixels in a separately bounded OCR working raster; default 16 million. */
  maxOcrPixels?: number;
  /**
   * Ruling lines kept for table detection across the document; default 200,000 (about 8 MB).
   * Pages scanned for tables keep their lines for later calls; beyond this budget the pages
   * cached first are dropped and scanned again when needed. A page draws at most 5,000 lines,
   * so a budget below that can leave a busy page uncached.
   */
  maxCachedRuleLines?: number;
}

/** Engine assets, password, resource budgets and an optional caller-owned OCR provider for a whole PDF. */
export interface OpenPdfOptions extends OperationOptions {
  /** Password supplied to the PDF security handler; no interactive password prompt is opened. */
  password?: string;
  /** Borrowed provider. Closing the PDF never closes this provider. */
  ocr?: OcrProvider;
  /** Resource budget overrides; full image export fails clearly instead of silently downscaling. */
  limits?: PdfLimits;
  /**
   * Default for {@link ExtractImageOptions.composite}: export images with everything drawn above
   * them, as they appear on the page. Default false.
   */
  composite?: boolean;
  /**
   * Default for {@link ExtractImageOptions.annotations}: include annotation appearances in
   * composites and count them in {@link ImageOccurrence.overlaid}. Default false.
   */
  annotations?: boolean;
  /** Self-hosted engine locations. Node defaults resolve included package assets; browser bundlers should set baseUrl. */
  assets?: {
    /** Base URL of the copied core asset directory, including sibling codecs, fonts and notices. */
    baseUrl?: string | URL;
    /** Override for the patched pdf.worker.mjs module; retain its sibling PNG encoder. */
    workerUrl?: string | URL;
    /** A WASM file URL whose directory contains the qcms/OpenJPEG runtime assets. */
    wasmUrl?: string | URL;
  };
}

/** Page selection, OCR policy and behavior when individual page or OCR-region operations fail. */
export interface StructuredTextOptions extends OperationOptions {
  /** Defaults to auto when a provider was supplied, otherwise off. Explicit auto/always requires a provider. */
  ocr?: OcrMode;
  /** One-based pages to extract; omitted means all pages. */
  pages?: readonly number[];
  /** throw rejects on failure (default); collect returns partial results with diagnostics. */
  errorMode?: 'throw' | 'collect';
  /**
   * Detect tables from ruling lines and aligned text columns (default true). Detected tables are
   * returned in {@link TextPage.tables} and read row by row in the text. false skips detection
   * and the extra vector-graphics scan it needs on pages with column-like text.
   */
  tables?: boolean;
}

/** Inventory selection. Images are enumerated without retaining all decoded rasters. */
export interface GetImagesOptions extends OperationOptions {
  /** One-based pages whose image occurrences are included; omitted means all pages. */
  pages?: readonly number[];
  /**
   * Positive minimum width in pixels; smaller images are left out and counted in
   * {@link ImageList.ignoredCount}. Measured as exported by default, so quarter-turn placements
   * count with width and height swapped. Omitted means no width filter.
   */
  minWidth?: number;
  /** Positive minimum height in pixels, measured like `minWidth`. Omitted means no height filter. */
  minHeight?: number;
  /**
   * Count annotation appearances in {@link ImageOccurrence.overlaid}, as `extractImage` does with
   * its `annotations` option. Defaults to the document's `annotations` option (false).
   */
  annotations?: boolean;
}

/** Embedded images returned by {@link PdfDocument.getImages}: an array with filter statistics. */
export interface ImageList extends ReadonlyArray<EmbeddedImage> {
  /** Images on the selected pages left out by `minWidth`/`minHeight`; 0 when unfiltered. Not part of JSON output. */
  readonly ignoredCount: number;
  /**
   * `IMAGE_INVENTORY_DEGRADED` for selected pages whose content has errors (for example text
   * shown before any font is set): they were read leniently, skipping broken operators, so
   * images in the broken part may be missing. Empty otherwise. Not part of JSON output.
   */
  readonly warnings: readonly ExtractionWarning[];
}

/** Export options. Omitting both bounds requests native dimensions; supplying a bound explicitly requests a thumbnail. */
export interface ExtractImageOptions extends OperationOptions {
  /** Positive maximum thumbnail width in pixels. Aspect ratio is preserved and images are not enlarged. */
  maxWidth?: number;
  /** Positive maximum thumbnail height in pixels. The full export is unchanged by preview generation. */
  maxHeight?: number;
  /** Placement whose on-page orientation is applied; defaults to the image's first occurrence. */
  occurrenceId?: string;
  /**
   * Return the raster in its stored orientation instead of how the placement shows it on the page.
   * By default, mirrored and quarter-turn placements are corrected losslessly (see {@link ImageOrientation}).
   */
  preserveOrientation?: boolean;
  /**
   * Render the image together with everything the page draws above it (text, vector graphics,
   * other images) in drawing order, cropped to the image's area. Defaults to the document's
   * `composite` option (false). Occurrences that are not overlaid, clipped, covered by an
   * included annotation or dependent on an unsupported graphics state export the exact stored
   * pixels instead, unless `scale` is set; see {@link ExtractedImage.composited}.
   */
  composite?: boolean;
  /** Include annotation appearances (stamps, markup, form fields) in a composite. Defaults to the document's `annotations` option (false). */
  annotations?: boolean;
  /**
   * Positive factor applied to the native size of a composite; default 1. Any other value always
   * renders the composite (`composited` is `'above'`, or `'page'` when the draw cannot be
   * isolated), even for occurrences that would otherwise export the exact stored pixels.
   * Ignored without `composite`.
   */
  scale?: number;
}

/** An independently owned PNG export that remains valid after the PDF is closed. */
export interface ExtractedImage {
  /** Asset identifier used for the export. */
  imageId: ImageId;
  /** Owned PNG bytes; never a live WASM view or a detached caller buffer. */
  data: Uint8Array<ArrayBuffer>;
  /** MIME type of the encoded output. */
  mimeType: 'image/png';
  /** Actual output width in pixels; swapped relative to the native width for quarter-turn placements. */
  width: number;
  /** Actual output height in pixels; swapped relative to the native height for quarter-turn placements. */
  height: number;
  /** full preserves native dimensions; thumbnail is an explicitly bounded preview. */
  variant: 'full' | 'thumbnail';
  /**
   * none: the exact stored pixels. above: a rendered composite of the image and everything
   * drawn above it. page: a rendered composite in which the image's own draw could not be
   * isolated, so content drawn below shows through transparent pixels too.
   */
  composited: 'none' | 'above' | 'page';
}

/** An open PDF handle. Operations are serialized per document; release it with close in a finally block. */
export interface PdfDocument {
  /** Total pages in the input PDF, independent of per-operation page selection. */
  readonly pageCount: number;
  /**
   * Extract native/OCR text with deterministic geometry-based ordering. Auto OCR includes image
   * regions on mixed pages. Tables are detected by default and returned in each page's `tables`;
   * each table also reads row by row, with tab-separated cells, in the text.
   */
  getStructuredText(options?: StructuredTextOptions): Promise<StructuredText>;
  /**
   * Enumerate appearances and placements, including inline/nested/reused images. Raster decoding
   * happens on demand. `minWidth`/`minHeight` leave out small images; all images are listed by default.
   * Each occurrence reports whether the page draws something above it (`overlaid`).
   */
  getImages(options?: GetImagesOptions): Promise<ImageList>;
  /**
   * Export a selected appearance as owned PNG bytes, oriented as its placement appears on the page
   * unless `preserveOrientation` is set. Unknown IDs fail; full export never silently downscales.
   * With `composite` (or the document's `composite` default), an overlaid or clipped occurrence
   * (see {@link ExtractImageOptions.composite} for all cases) is rendered with everything drawn
   * above it, cropped to its area; `composited` reports which.
   */
  extractImage(id: ImageId, options?: ExtractImageOptions): Promise<ExtractedImage>;
  /** Idempotently cancel queued work and join engine cleanup. Returned data remains valid; the OCR provider stays open. */
  close(): Promise<void>;
}

/** Axis-aligned bounds. Text/image results use canonical page points; OCR provider results use input raster pixels. */
export interface Box {
  /** Left coordinate. */
  x: number;
  /** Top coordinate, increasing downward. */
  y: number;
  /** Extent along the x axis. */
  width: number;
  /** Extent along the y axis. */
  height: number;
}

/** Four x/y corner pairs in the same coordinate system as the associated bounding box. */
export type Quad = readonly [number, number, number, number, number, number, number, number];

/** Serializable diagnostic attached to the affected document, page or image. */
export interface ExtractionWarning {
  /** Stable diagnostic category suitable for application handling. */
  code: string;
  /** Human-readable description of the limitation or failure. */
  message: string;
  /** Affected one-based page when known. */
  pageNumber?: number;
  /** Affected appearance identifier when known. */
  imageId?: ImageId;
}

/** A native text run or recognized OCR word with geometry and explicit provenance. */
export interface TextSpan {
  /** Text content of the native run or OCR word. */
  text: string;
  /** Axis-aligned bounds in canonical page points (1/72 inch). */
  bbox: Box;
  /** Optional four-corner geometry in canonical page points. */
  quad?: Quad;
  /** Whether the span came from the PDF text layer or OCR. */
  source: 'native' | 'ocr';
  /** OCR confidence in [0,1] when supplied; native text has no recognition confidence. */
  confidence?: number;
  /** Source embedded appearance for regional OCR, when applicable. */
  imageId?: ImageId;
  /** Native PDF font identifier when available; not a claim that the font is installed. */
  fontName?: string;
  /** Native text size in canonical page points when available. */
  fontSize?: number;
}

/** Spans grouped into a deterministic geometric baseline row, without a semantic-layout guarantee. */
export interface TextLine {
  /** Text derived from this line’s ordered spans. */
  text: string;
  /** Union of span bounds in canonical page points. */
  bbox: Box;
  /** Ordered text runs/words with individual provenance. */
  spans: TextSpan[];
}

/**
 * Lines grouped heuristically by columns and paragraph spacing. A detected table forms one
 * block with one line per table row, its cells separated by tab characters.
 */
export interface TextBlock {
  /** Text derived from this block’s ordered lines. */
  text: string;
  /** Union of line bounds in canonical page points. */
  bbox: Box;
  /** Lines in deterministic geometric reading order. */
  lines: TextLine[];
  /** Index into {@link TextPage.tables} when this block is a detected table. */
  tableIndex?: number;
}

/** One cell of a detected table. Bounds are the cell's grid area, not only its text. */
export interface TableCell {
  /** Zero-based row of the cell's top-left grid position. */
  row: number;
  /** Zero-based column of the cell's top-left grid position. */
  column: number;
  /** Number of grid rows the cell covers; greater than 1 only for ruled merged cells. */
  rowSpan: number;
  /** Number of grid columns the cell covers; greater than 1 only for ruled merged cells. */
  columnSpan: number;
  /** Cell text with its lines joined by newlines; empty for an empty cell. */
  text: string;
  /** Cell area in canonical page points. */
  bbox: Box;
}

/** A heuristically detected table; all geometry uses canonical page points. */
export interface Table {
  /** Table area in canonical page points. */
  bbox: Box;
  /** Number of grid rows. */
  rowCount: number;
  /** Number of grid columns. */
  columnCount: number;
  /**
   * ruled: the cell grid comes from drawn horizontal and vertical lines, so merged cells are known.
   * aligned: columns are inferred from text alignment, optionally between horizontal rules.
   */
  detection: 'ruled' | 'aligned';
  /** Cells in row-major order, empty cells included; positions covered by a merged cell are omitted. */
  cells: TableCell[];
}

/** Text and diagnostics in top-left page points, with CropBox, UserUnit and rotation applied. */
export interface TextPage {
  /** Original one-based PDF page number. */
  pageNumber: number;
  /** Canonical page width in points after crop, user-unit scaling and rotation. */
  width: number;
  /** Canonical page height in points after crop, user-unit scaling and rotation. */
  height: number;
  /** Original PDF page rotation in clockwise degrees. */
  rotation: 0 | 90 | 180 | 270;
  /** Text derived from ordered blocks on this page. */
  fullText: string;
  /** Geometrically ordered text blocks; complex semantic reading order is not guaranteed. */
  blocks: TextBlock[];
  /** Detected tables in reading order; empty when none were found or detection was disabled. */
  tables: Table[];
  /** Coverage outcome. A failed region cannot be hidden by another region succeeding. */
  ocrStatus: 'disabled' | 'not-needed' | 'performed' | 'partial' | 'failed';
  /** Page-local limitations and collected errors. */
  warnings: ExtractionWarning[];
}

/** JSON-serializable extraction result. Partial status explicitly records collected failures. */
export interface StructuredText {
  /** Version of the serializable text-result schema. */
  schemaVersion: 1;
  /** complete means requested extraction succeeded; partial preserves explicit failures in collect mode. */
  status: 'complete' | 'partial';
  /** Total pages in the PDF, even if only a subset was requested. */
  pageCount: number;
  /** Plain text derived from the ordered returned pages. */
  fullText: string;
  /** Requested page results in deterministic page order. */
  pages: TextPage[];
  /** Document-level and aggregated extraction diagnostics. */
  warnings: ExtractionWarning[];
}

/** PDF-style [a,b,c,d,e,f]: x′ = a*x + c*y + e, y′ = b*x + d*y + f. */
export type AffineTransform = readonly [number, number, number, number, number, number];

/**
 * How a stored raster is oriented relative to its appearance on the page. To display it as on the
 * page, mirror it horizontally when `mirrored` is true, then rotate it clockwise by `rotation`
 * degrees. `{ rotation: 0, mirrored: false }` means the stored raster is already upright.
 * Rotation is rounded to the nearest quarter turn; smaller tilts are left in place.
 */
export interface ImageOrientation {
  /** Clockwise rotation in degrees, applied after any mirroring. */
  rotation: 0 | 90 | 180 | 270;
  /** Whether the placement mirrors the stored raster. */
  mirrored: boolean;
}

/** One placement of an embedded appearance; repeated uses remain distinct even when their asset is shared. */
export interface ImageOccurrence {
  /** Distinct document-scoped placement identifier. */
  occurrenceId: string;
  /** One-based page containing this placement. */
  pageNumber: number;
  /** Unclipped placement bounds in canonical page points. */
  bbox: Box;
  /** Maps top-left source raster pixel edges into canonical page coordinates. */
  imageToPage: AffineTransform;
  /**
   * Whether a clip cuts this placement. False when every clip in effect is an axis-aligned
   * rectangle (including Form XObject bounds) containing the whole image, such as a page-wide
   * clip; true for clips that cut into it and, conservatively, for non-rectangular, rotated and
   * text clips. Standalone export still preserves the whole source image.
   */
  clipped: boolean;
  /** Orientation of the stored raster relative to this placement; exports correct it by default. */
  originalOrientation: ImageOrientation;
  /**
   * Whether the page draws something visible above this placement within its area: text,
   * vector graphics or another image, within the clip area (annotations too with the
   * `annotations` option of `getImages` or the document). Text extents are estimated, so this
   * errs towards true; invisible text such as an OCR layer does not count.
   */
  overlaid: boolean;
}

/** A source-resolution embedded raster appearance. Auxiliary masks are applied to the asset, not listed separately. */
export interface EmbeddedImage {
  /** Opaque identifier for this document and appearance variant. */
  id: ImageId;
  /** Native source width in pixels, independent of page placement size and orientation. */
  width: number;
  /** Native source height in pixels, independent of page placement orientation. */
  height: number;
  /** Original sample bit depth when available; exported PNG pixels are RGBA8. */
  bitsPerComponent?: number;
  /** Engine-reported source color-space description when available. */
  colorSpace?: string;
  /** Whether masks or transparency require an alpha channel. */
  hasAlpha: boolean;
  /** All selected placements of this appearance, retaining distinct repeated occurrences. */
  occurrences: ImageOccurrence[];
  /** Known limitations for this embedded appearance. */
  warnings: ExtractionWarning[];
}

/** Owned RGBA8 working raster passed to an OCR provider. Provider geometry must refer to these input pixels. */
export interface OcrRaster {
  /** RGBA bytes owned independently of caller PDF input and engine memory. */
  data: Uint8Array<ArrayBuffer>;
  /** Input raster width in pixels. */
  width: number;
  /** Input raster height in pixels. */
  height: number;
  /** Bytes per row; the bundled Tesseract provider requires width × 4. */
  stride: number;
  /** Eight-bit red/green/blue/alpha channel order. */
  format: 'rgba8';
}

/** One recognized word, measured in the original input raster pixel coordinate system. */
export interface OcrWord {
  /** Recognized word text. */
  text: string;
  /** Bounds in supplied raster pixels after undoing provider preprocessing. */
  bbox: Box;
  /** Recognition confidence normalized to [0,1], when available. */
  confidence?: number;
}

/** Recognized words grouped into a line in input raster pixels. */
export interface OcrLine {
  /** Recognized line text. */
  text: string;
  /** Line bounds in supplied raster pixels. */
  bbox: Box;
  /** Words and their normalized geometry. */
  words: OcrWord[];
}

/** Provider result normalized back through any provider preprocessing to the supplied raster. */
export interface OcrResult {
  /** Plain text recognized from the raster. */
  text: string;
  /** Line and word geometry in original input raster pixels, not preprocessed coordinates. */
  lines: OcrLine[];
  /** Recognition limitations or coverage diagnostics. */
  warnings: ExtractionWarning[];
}

/** Engine-neutral, caller-owned OCR service that may be shared across PDF handles. */
export interface OcrProvider {
  /** Recognize one raster and return input-pixel geometry. Core maps those coordinates into the page. */
  recognize(raster: OcrRaster, options?: OperationOptions): Promise<OcrResult>;
  /** Idempotently release provider-owned workers/resources. The application calls this after all borrowing PDFs finish. */
  close(): Promise<void>;
}

/** Bytes or a web byte stream. A stream is consumed once; bytes are preserved without re-encoding. */
export type StorageBody = Uint8Array | ReadableStream<Uint8Array>;

/** Upload progress reporting completed bytes without inflating counts for retries. */
export interface StorageProgress {
  /** uploading reports confirmed bytes; complete indicates publication succeeded. */
  phase: 'uploading' | 'complete';
  /** Successfully uploaded bytes, counted once across part retries. */
  loaded: number;
  /** Expected body length when known. */
  total?: number;
}

/** Metadata, length validation, cancellation and progress for a storage write. */
export interface StoragePutOptions {
  /** Persisted MIME type; at most 255 printable ASCII characters. */
  contentType?: string;
  /** Expected byte length. A mismatch rejects before successful publication. */
  contentLength?: number;
  /** Portable lowercase ASCII keys (≤64 chars) and printable ASCII values; combined maximum 2048 bytes. */
  metadata?: Readonly<Record<string, string>>;
  /** Cancels reading/uploading and requests cleanup; commit uncertainty is reported separately. */
  signal?: AbortSignal;
  /** Receives byte progress. Retries do not count bytes a second time. */
  onProgress?: (progress: StorageProgress) => void;
}

/** Cancellation for reading object metadata/body or deleting a key. */
export interface StorageReadOptions {
  /** Cancels the requested operation and, for get, its body stream. */
  signal?: AbortSignal;
}

/** Portable metadata for one logical object; backend-specific identifiers are optional and opaque. */
export interface StorageObjectInfo {
  /** Logical relative ASCII key, independent of a configured physical prefix/root. */
  key: string;
  /** Stored body length in bytes. */
  size: number;
  /** Preserved MIME type when provided. */
  contentType?: string;
  /** Preserved portable user metadata. */
  metadata?: Record<string, string>;
  /** Opaque backend generation/entity identifier; not necessarily a content hash. */
  etag?: string;
  /** Backend object version identifier when supported and returned. */
  versionId?: string;
  /** ISO 8601 timestamp when available. */
  lastModified?: string;
}

/** One stored object generation with a web stream; consume or cancel the stream to release resources. */
export interface StorageObject extends StorageObjectInfo {
  /** Web byte stream containing the exact stored body. Consume or cancel it. */
  body: ReadableStream<Uint8Array>;
}

/** Portable logical-key storage contract. Missing objects and permission/network failures use distinct typed errors. */
export interface StorageAdapter {
  /** Create or replace an object. S3 uses strict multipart; failed pre-completion replacement preserves the old object. */
  put(key: string, body: StorageBody, options?: StoragePutOptions): Promise<StorageObjectInfo>;
  /** Read one object generation and metadata; rejects with STORAGE_NOT_FOUND for a missing key. */
  get(key: string, options?: StorageReadOptions): Promise<StorageObject>;
  /** Read metadata without transferring the body; missing and access/network errors remain distinct. */
  head(key: string, options?: StorageReadOptions): Promise<StorageObjectInfo>;
  /** Idempotently remove a logical key. A missing key succeeds; access/network failures still reject. */
  delete(key: string, options?: StorageReadOptions): Promise<void>;
}

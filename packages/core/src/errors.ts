/** Stable machine-readable failures across extraction, OCR and storage. COMMIT_OUTCOME_UNKNOWN requires reconciliation. */
export type ErrorCode =
  | 'INVALID_PDF'
  | 'PASSWORD_REQUIRED'
  | 'INVALID_PASSWORD'
  | 'INVALID_ARGUMENT'
  | 'DOCUMENT_CLOSED'
  | 'ABORTED'
  | 'UNSUPPORTED_PDF_FEATURE'
  | 'UNSUPPORTED_IMAGE_FEATURE'
  | 'IMAGE_NOT_FOUND'
  | 'RESOURCE_LIMIT_EXCEEDED'
  | 'TEXT_EXTRACTION_FAILED'
  | 'OCR_PROVIDER_REQUIRED'
  | 'OCR_FAILED'
  | 'OCR_ASSET_UNAVAILABLE'
  | 'INVALID_STORAGE_KEY'
  | 'STORAGE_NOT_FOUND'
  | 'STORAGE_PERMISSION_DENIED'
  | 'STORAGE_IO_ERROR'
  | 'STORAGE_CAPABILITY_UNSUPPORTED'
  | 'CONTENT_LENGTH_MISMATCH'
  | 'MULTIPART_UPLOAD_FAILED'
  | 'COMMIT_OUTCOME_UNKNOWN';
/** Typed failure preserving a primary cause, operation context and any cleanup failures. */
export class PdfExtractError extends Error {
  /** Failure category suitable for branching independently of the human-readable message. */
  readonly code: ErrorCode;
  /** Available page, image, key or other operation context. Do not attach credentials. */
  readonly context: Readonly<Record<string, unknown>>;
  /** Secondary failures such as an unsuccessful multipart abort; the primary cause remains preserved. */
  cleanupErrors?: unknown[];
  /** Construct a typed error with an optional original cause and safe context. */
  constructor(
    code: ErrorCode,
    message: string,
    options: {
      /** Original underlying failure. */
      cause?: unknown;
      /** Safe diagnostic fields for the affected operation. */
      context?: Record<string, unknown>;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'PdfExtractError';
    this.code = code;
    this.context = options.context ?? {};
  }
}
/** Throw ABORTED if the supplied signal has already fired; preserve its reason as the cause. */
export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new PdfExtractError('ABORTED', 'Operation cancelled', { cause: signal.reason });
}
/** Validate and return a positive safe integer, or throw INVALID_ARGUMENT naming the invalid option. */
export function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new PdfExtractError('INVALID_ARGUMENT', `${name} must be a positive safe integer`);
  return value;
}

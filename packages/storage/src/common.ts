import type { StorageBody, StoragePutOptions } from '@pdfextract/core';
import { checkAbort, PdfExtractError } from '@pdfextract/core';
export function validateKey(key: string): string {
  if (
    typeof key !== 'string' ||
    key.length > 1024 ||
    !key.split('/').every((part) => /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(part))
  )
    throw new PdfExtractError(
      'INVALID_STORAGE_KEY',
      'Keys must be relative ASCII paths with nonempty alphanumeric/underscore-led segments (max 1024 characters)',
      { context: { key } },
    );
  return key;
}
export function validatePut(options: StoragePutOptions) {
  if (
    options.contentLength !== undefined &&
    (!Number.isSafeInteger(options.contentLength) || options.contentLength < 0)
  )
    throw new PdfExtractError('INVALID_ARGUMENT', 'Invalid contentLength');
  if (options.contentType !== undefined && !/^[\x20-\x7e]{1,255}$/.test(options.contentType))
    throw new PdfExtractError('INVALID_ARGUMENT', 'Invalid contentType');
  let total = 0;
  for (const [key, value] of Object.entries(options.metadata ?? {})) {
    if (
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(key) ||
      typeof value !== 'string' ||
      !/^[\x20-\x7e]*$/.test(value)
    )
      throw new PdfExtractError(
        'INVALID_ARGUMENT',
        'Metadata requires lowercase ASCII keys and printable ASCII values',
      );
    total += key.length + value.length;
  }
  if (total > 2048) throw new PdfExtractError('INVALID_ARGUMENT', 'Metadata exceeds 2048 bytes');
}
export async function* chunks(body: StorageBody, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  checkAbort(signal);
  if (body instanceof Uint8Array) {
    yield body;
    return;
  }
  if (!body || typeof body.getReader !== 'function')
    throw new PdfExtractError('INVALID_ARGUMENT', 'Expected bytes or a web byte stream');
  const reader = body.getReader();
  const abort = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  let complete = false;
  try {
    while (true) {
      checkAbort(signal);
      const result = await reader.read();
      checkAbort(signal);
      if (result.done) {
        complete = true;
        return;
      }
      if (!(result.value instanceof Uint8Array))
        throw new PdfExtractError('INVALID_ARGUMENT', 'Stream chunks must be Uint8Array');
      if (result.value.length) yield result.value;
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export function lengthCheck(actual: number, expected?: number) {
  if (expected !== undefined && actual !== expected)
    throw new PdfExtractError(
      'CONTENT_LENGTH_MISMATCH',
      `Expected ${expected} bytes, received ${actual}`,
    );
}
export function storageError(error: unknown, key: string): PdfExtractError {
  if (error instanceof PdfExtractError) return error;
  const e = error as { code?: string; name?: string; $metadata?: { httpStatusCode?: number } };
  const status = e.$metadata?.httpStatusCode;
  const code =
    e.code === 'ENOENT' || e.name === 'NoSuchKey' || e.name === 'NotFound' || status === 404
      ? 'STORAGE_NOT_FOUND'
      : e.code === 'EACCES' || e.code === 'EPERM' || e.name === 'AccessDenied' || status === 403
        ? 'STORAGE_PERMISSION_DENIED'
        : 'STORAGE_IO_ERROR';
  return new PdfExtractError(code, `Storage operation failed for ${key}`, {
    cause: error,
    context: { key },
  });
}

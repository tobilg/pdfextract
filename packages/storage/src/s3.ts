/**
 * Strict multipart S3 storage using a caller-owned AWS SDK v3 client.
 * See [S3 usage](../README.md#s3) on the storage package page.
 * @module @pdfextract/storage/s3
 * @group @pdfextract/storage
 */
import type { CompletedPart, HeadObjectOutput, S3Client } from '@aws-sdk/client-s3';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import type { StorageAdapter, StorageBody } from '@pdfextract/core';
import { checkAbort, PdfExtractError, positive } from '@pdfextract/core';
import { chunks, lengthCheck, storageError, validateKey, validatePut } from './common.js';
/** Caller-authorized S3 configuration; compatible endpoints are configured on the client. */
export interface S3StorageOptions {
  /** Borrowed AWS SDK v3 client; this adapter never destroys it or configures credentials. */
  client: S3Client;
  /** Existing bucket to use; the adapter never provisions one. */
  bucket: string;
  /** Optional portable logical prefix; a trailing slash is normalized. Prefix plus key is limited to 1024 ASCII characters. */
  prefix?: string;
  /** Explicit multipart settings. Small and empty bodies never fall back to PutObject. */
  multipart?: {
    /** The only supported mode; every write uses multipart creation and completion. */
    mode?: 'always';
    /** Replayable part size in bytes, 5 MiB–5 GiB; default 8 MiB. At most 10,000 parts are allowed. */
    partSize?: number;
    /** Maximum concurrent part uploads, 1–32; defaults to three. */
    concurrency?: number;
  };
}
const MiB = 1024 * 1024,
  MAX_PARTS = 10000;
async function* parts(body: StorageBody, size: number, signal: AbortSignal) {
  let buffer = new Uint8Array(size),
    used = 0,
    count = 0;
  for await (const chunk of chunks(body, signal)) {
    let offset = 0;
    while (offset < chunk.length) {
      const take = Math.min(size - used, chunk.length - offset);
      buffer.set(chunk.subarray(offset, offset + take), used);
      used += take;
      offset += take;
      if (used === size) {
        yield buffer;
        count++;
        buffer = new Uint8Array(size);
        used = 0;
      }
    }
  }
  if (used || !count) yield buffer.slice(0, used);
}
/**
 * Create strict multipart storage with bounded upload concurrency and byte-preserving reads.
 * @param options - Caller-owned client, existing bucket, key prefix and multipart budgets.
 * @returns A core StorageAdapter. Consume/cancel get streams; retain ownership of the S3 client.
 * @remarks Replacement never deletes the old key first. Failures settle active work before abort;
 * cleanup failures are preserved. A lost completion response yields COMMIT_OUTCOME_UNKNOWN,
 * requiring reconciliation rather than claiming rollback. Empty multipart support is backend-specific.
 */
export function createS3Storage({
  client,
  bucket,
  prefix = '',
  multipart = {},
}: S3StorageOptions): StorageAdapter {
  const partSize = positive(multipart.partSize ?? 8 * MiB, 'partSize'),
    concurrency = positive(multipart.concurrency ?? 3, 'concurrency');
  if (
    partSize < 5 * MiB ||
    partSize > 5 * 1024 * MiB ||
    concurrency > 32 ||
    (multipart.mode && multipart.mode !== 'always')
  )
    throw new PdfExtractError(
      'INVALID_ARGUMENT',
      'Multipart requires 5 MiB–5 GiB parts, concurrency 1–32 and mode always',
    );
  if (!bucket) throw new PdfExtractError('INVALID_ARGUMENT', 'bucket is required');
  if (prefix) {
    validateKey(prefix.replace(/\/$/, ''));
    if (!prefix.endsWith('/')) prefix += '/';
  }
  const physical = (key: string) => validateKey(prefix + validateKey(key));
  const info = (key: string, r: HeadObjectOutput) => ({
    key,
    size: r.ContentLength ?? 0,
    contentType: r.ContentType,
    metadata: r.Metadata ?? {},
    etag: r.ETag,
    versionId: r.VersionId,
    lastModified: r.LastModified?.toISOString(),
  });
  return {
    async put(key, body, options = {}) {
      const Key = physical(key);
      validatePut(options);
      checkAbort(options.signal);
      const known = body instanceof Uint8Array ? body.length : options.contentLength;
      if (body instanceof Uint8Array) lengthCheck(body.length, options.contentLength);
      if (known !== undefined && Math.ceil(known / partSize) > MAX_PARTS)
        throw new PdfExtractError(
          'RESOURCE_LIMIT_EXCEEDED',
          'Body exceeds configured multipart capacity',
        );
      const controller = new AbortController(),
        signal = options.signal
          ? AbortSignal.any([controller.signal, options.signal])
          : controller.signal;
      let uploadId: string | undefined,
        size = 0,
        loaded = 0,
        completionStarted = false,
        committed = false,
        primary: unknown;
      const completed: (CompletedPart & { PartNumber: number })[] = [],
        active = new Set<Promise<void>>();
      const iterator = parts(body, partSize, signal)[Symbol.asyncIterator]();
      try {
        let next = await iterator.next();
        checkAbort(signal);
        const start = await client.send(
          new CreateMultipartUploadCommand({
            Bucket: bucket,
            Key,
            ContentType: options.contentType,
            Metadata: options.metadata ? { ...options.metadata } : undefined,
          }),
          { abortSignal: signal },
        );
        uploadId = start.UploadId;
        if (!uploadId) throw new Error('Backend did not return UploadId');
        let number = 0;
        while (!next.done) {
          checkAbort(signal);
          if (primary) throw primary;
          const PartNumber = ++number;
          if (PartNumber > MAX_PARTS)
            throw new PdfExtractError('RESOURCE_LIMIT_EXCEEDED', 'Multipart part count exceeded');
          const bytes = next.value;
          size += bytes.length;
          if (options.contentLength !== undefined && size > options.contentLength)
            lengthCheck(size, options.contentLength);
          let work!: Promise<void>;
          work = (async () => {
            try {
              const result = await client.send(
                new UploadPartCommand({
                  Bucket: bucket,
                  Key,
                  UploadId: uploadId,
                  PartNumber,
                  Body: bytes,
                  ContentLength: bytes.length,
                  ChecksumAlgorithm: start.ChecksumAlgorithm,
                }),
                { abortSignal: signal },
              );
              if (!result.ETag) throw new Error('Part response has no ETag');
              completed.push({
                PartNumber,
                ETag: result.ETag,
                ChecksumCRC32: result.ChecksumCRC32,
                ChecksumCRC32C: result.ChecksumCRC32C,
                ChecksumSHA1: result.ChecksumSHA1,
                ChecksumSHA256: result.ChecksumSHA256,
                ChecksumCRC64NVME: result.ChecksumCRC64NVME,
                ChecksumSHA512: result.ChecksumSHA512,
                ChecksumMD5: result.ChecksumMD5,
                ChecksumXXHASH64: result.ChecksumXXHASH64,
                ChecksumXXHASH3: result.ChecksumXXHASH3,
                ChecksumXXHASH128: result.ChecksumXXHASH128,
              });
              loaded += bytes.length;
              options.onProgress?.({ phase: 'uploading', loaded, total: known });
            } catch (error) {
              primary ??= error;
              controller.abort(error);
            } finally {
              active.delete(work);
            }
          })();
          active.add(work);
          if (active.size >= concurrency) await Promise.race(active);
          if (primary) throw primary;
          next = await iterator.next();
        }
        await Promise.all(active);
        if (primary) throw primary;
        checkAbort(signal);
        lengthCheck(size, options.contentLength);
        completionStarted = true;
        const result = await client.send(
          new CompleteMultipartUploadCommand({
            Bucket: bucket,
            Key,
            UploadId: uploadId,
            MultipartUpload: { Parts: completed.sort((a, b) => a.PartNumber - b.PartNumber) },
            ChecksumType: start.ChecksumType,
          }),
          { abortSignal: signal },
        );
        committed = true;
        options.onProgress?.({ phase: 'complete', loaded: size, total: known });
        return {
          key,
          size,
          contentType: options.contentType,
          metadata: { ...options.metadata },
          etag: result.ETag,
          versionId: result.VersionId,
        };
      } catch (error) {
        primary ??= error;
        controller.abort();
        await Promise.allSettled(active);
        await iterator.return?.();
        const context = { key, bucket, uploadId, completionStarted };
        const status = (primary as { $metadata?: { httpStatusCode?: number } })?.$metadata
          ?.httpStatusCode;
        let failure: PdfExtractError;
        if (completionStarted && !committed)
          failure = new PdfExtractError(
            'COMMIT_OUTCOME_UNKNOWN',
            'Completion may have published the object; inspect the key before cleaning dependent assets',
            { cause: primary, context },
          );
        else if (primary instanceof PdfExtractError) failure = primary;
        else if (options.signal?.aborted)
          failure = new PdfExtractError('ABORTED', 'Upload cancelled', { cause: primary, context });
        else if (size === 0 && (status === 400 || status === 501))
          failure = new PdfExtractError(
            'STORAGE_CAPABILITY_UNSUPPORTED',
            'Backend rejected strict empty multipart upload',
            { cause: primary, context },
          );
        else
          failure = new PdfExtractError('MULTIPART_UPLOAD_FAILED', 'Multipart upload failed', {
            cause: primary,
            context,
          });
        if (uploadId && !committed)
          try {
            await client.send(
              new AbortMultipartUploadCommand({ Bucket: bucket, Key, UploadId: uploadId }),
              { abortSignal: AbortSignal.timeout(10000) },
            );
          } catch (cleanup) {
            failure.cleanupErrors = [cleanup];
          }
        throw failure;
      } finally {
        await iterator.return?.();
      }
    },
    async head(key, options = {}) {
      const Key = physical(key);
      checkAbort(options.signal);
      try {
        return info(
          key,
          await client.send(new HeadObjectCommand({ Bucket: bucket, Key }), {
            abortSignal: options.signal,
          }),
        );
      } catch (e) {
        checkAbort(options.signal);
        throw storageError(e, key);
      }
    },
    async get(key, options = {}) {
      const Key = physical(key);
      checkAbort(options.signal);
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key }), {
          abortSignal: options.signal,
        });
        if (!result.Body) throw new Error('Missing response body');
        return {
          ...info(key, result),
          body: result.Body.transformToWebStream() as ReadableStream<Uint8Array>,
        };
      } catch (e) {
        checkAbort(options.signal);
        throw storageError(e, key);
      }
    },
    async delete(key, options = {}) {
      const Key = physical(key);
      checkAbort(options.signal);
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key }), {
          abortSignal: options.signal,
        });
      } catch (e) {
        checkAbort(options.signal);
        const error = storageError(e, key);
        if (error.code !== 'STORAGE_NOT_FOUND') throw error;
      }
    },
  };
}

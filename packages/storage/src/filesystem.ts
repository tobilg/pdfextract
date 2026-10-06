/**
 * Node-only storage with streamed writes and coherent atomic body/metadata replacement.
 * See [filesystem usage](../README.md#filesystem) on the storage package page.
 * @module @pdfextract/storage/filesystem
 * @group @pdfextract/storage
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { StorageAdapter, StorageObjectInfo, StorageReadOptions } from '@pdfextract/core';
import { checkAbort, PdfExtractError } from '@pdfextract/core';
import { chunks, lengthCheck, storageError, validateKey, validatePut } from './common.js';
/** Private filesystem root configuration for a Node storage adapter. */
export interface FilesystemStorageOptions {
  /** Root directory, created on first use. Symlink aliases are rejected; use realpath and trusted, stable ancestors. */
  directory: string;
}
/**
 * Store exact bytes and metadata in one atomically replaced record per logical key.
 * @param options - Private canonical directory; relative paths resolve against the working directory.
 * @returns An adapter whose get returns a web byte stream and whose delete is idempotent.
 * @remarks Files are fsynced before rename. Directory fsync, Windows/network-filesystem durability and
 * protection from a privileged concurrent ancestor-directory swap are not promised.
 */
export function createFilesystemStorage({ directory }: FilesystemStorageOptions): StorageAdapter {
  if (typeof directory !== 'string' || !directory)
    throw new PdfExtractError('INVALID_ARGUMENT', 'directory is required');
  const root = resolve(directory);
  let initialization: Promise<void> | undefined;
  async function ready() {
    initialization ??= (async () => {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const stat = await lstat(root);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new PdfExtractError(
          'STORAGE_PERMISSION_DENIED',
          'Storage root must be a real directory',
        );
    })();
    await initialization;
    const stat = await lstat(root);
    if (stat.isSymbolicLink() || (await realpath(root)) !== root)
      throw new PdfExtractError(
        'STORAGE_PERMISSION_DENIED',
        'Storage root resolves through a symlink',
      );
  }
  const path = (key: string) =>
    join(root, `${createHash('sha256').update(validateKey(key)).digest('hex')}.object`);
  async function read(key: string, options: StorageReadOptions = {}) {
    validateKey(key);
    checkAbort(options.signal);
    await ready();
    const file = await open(path(key), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      const length = Buffer.alloc(4);
      if ((await file.read(length, 0, 4, 0)).bytesRead !== 4)
        throw new Error('Invalid object header');
      const size = length.readUInt32BE();
      if (size > 8192 || stat.size < size + 4) throw new Error('Invalid object record');
      const header = Buffer.alloc(size);
      if ((await file.read(header, 0, size, 4)).bytesRead !== size)
        throw new Error('Truncated object header');
      const value = JSON.parse(header.toString());
      if (value.key !== key) throw new Error('Invalid object key');
      const info: StorageObjectInfo = {
        key,
        size: stat.size - size - 4,
        contentType: value.contentType,
        metadata: value.metadata,
        etag: value.etag,
        lastModified: stat.mtime.toISOString(),
      };
      checkAbort(options.signal);
      return { file, offset: size + 4, info };
    } catch (e) {
      await file.close();
      throw e;
    }
  }
  return {
    async put(key, body, options = {}) {
      validateKey(key);
      validatePut(options);
      checkAbort(options.signal);
      const temp = join(root, `.write-${randomUUID()}`);
      let file: Awaited<ReturnType<typeof open>> | undefined;
      let published = false;
      let failure: PdfExtractError | undefined;
      try {
        await ready();
        file = await open(
          temp,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
        const etag = randomUUID(),
          header = Buffer.from(
            JSON.stringify({
              key,
              contentType: options.contentType,
              metadata: options.metadata ?? {},
              etag,
            }),
          ),
          length = Buffer.alloc(4);
        length.writeUInt32BE(header.length);
        const outputFile = file;
        async function write(bytes: Uint8Array) {
          let offset = 0;
          while (offset < bytes.length) {
            checkAbort(options.signal);
            const { bytesWritten } = await outputFile.write(bytes, offset, bytes.length - offset);
            if (!bytesWritten) throw new Error('No write progress');
            offset += bytesWritten;
          }
        }
        await write(length);
        await write(header);
        let size = 0;
        for await (const chunk of chunks(body, options.signal)) {
          await write(chunk);
          size += chunk.length;
          if (options.contentLength !== undefined && size > options.contentLength)
            lengthCheck(size, options.contentLength);
          options.onProgress?.({ phase: 'uploading', loaded: size, total: options.contentLength });
        }
        lengthCheck(size, options.contentLength);
        await file.sync();
        await file.close();
        file = undefined;
        checkAbort(options.signal);
        await rename(temp, path(key));
        published = true;
        options.onProgress?.({ phase: 'complete', loaded: size, total: options.contentLength });
        return {
          key,
          size,
          contentType: options.contentType,
          metadata: { ...options.metadata },
          etag,
          lastModified: new Date().toISOString(),
        };
      } catch (error) {
        failure = options.signal?.aborted
          ? new PdfExtractError('ABORTED', 'Write cancelled', {
              cause: error,
              context: { key, published },
            })
          : storageError(error, key);
        throw failure;
      } finally {
        const cleanupErrors: unknown[] = [];
        try {
          await file?.close();
        } catch (error) {
          cleanupErrors.push(error);
        }
        if (!published) {
          try {
            await unlink(temp);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupErrors.push(error);
          }
        }
        if (cleanupErrors.length && failure) failure.cleanupErrors = cleanupErrors;
      }
    },
    async head(key, options = {}) {
      try {
        const { file, info } = await read(key, options);
        await file.close();
        return info;
      } catch (error) {
        checkAbort(options.signal);
        throw storageError(error, key);
      }
    },
    async get(key, options = {}) {
      try {
        const { file, offset, info } = await read(key, options);
        const stream = file.createReadStream({
          start: offset,
          autoClose: true,
          signal: options.signal,
        });
        return { ...info, body: Readable.toWeb(stream) as ReadableStream<Uint8Array> };
      } catch (error) {
        checkAbort(options.signal);
        throw storageError(error, key);
      }
    },
    async delete(key, options = {}) {
      validateKey(key);
      checkAbort(options.signal);
      try {
        await ready();
        await unlink(path(key));
      } catch (error) {
        const e = storageError(error, key);
        if (e.code !== 'STORAGE_NOT_FOUND') throw e;
      }
    },
  };
}

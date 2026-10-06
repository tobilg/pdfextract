import type { StorageAdapter, StorageObjectInfo } from '@pdfextract/core';
import { PdfExtractError } from '@pdfextract/core';
// Example host storage, intentionally not a fourth publishable adapter. IndexedDB
// publishes each Blob and metadata in the same transaction. This demo caps objects
// at 64 MiB; production hosts can supply S3 or another adapter.
export function createDemoStorage(): StorageAdapter {
  const db = new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open('pdfextract-example', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('objects');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  async function request<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest,
  ): Promise<T> {
    const database = await db;
    return new Promise((resolve, reject) => {
      const tx = database.transaction('objects', mode),
        r = operation(tx.objectStore('objects'));
      tx.oncomplete = () => resolve(r.result);
      tx.onabort = tx.onerror = () => reject(tx.error ?? r.error);
    });
  }
  async function get(key: string) {
    const object = await request<{ buffer: ArrayBuffer; info: StorageObjectInfo } | undefined>(
      'readonly',
      (s) => s.get(key),
    );
    if (!object) throw new PdfExtractError('STORAGE_NOT_FOUND', 'Local demo object missing');
    return object;
  }
  return {
    async put(key, body, options = {}) {
      options.signal?.throwIfAborted();
      const blob = await new Response(
        body instanceof Uint8Array ? new Uint8Array(body) : body,
      ).blob();
      if (blob.size > 64 * 1024 * 1024)
        throw new PdfExtractError(
          'RESOURCE_LIMIT_EXCEEDED',
          'Demo browser storage is limited to 64 MiB per object',
        );
      options.signal?.throwIfAborted();
      if (options.contentLength !== undefined && blob.size !== options.contentLength)
        throw new PdfExtractError('CONTENT_LENGTH_MISMATCH', 'Incorrect length');
      const info = {
        key,
        size: blob.size,
        contentType: options.contentType,
        metadata: { ...options.metadata },
      };
      const buffer = await blob.arrayBuffer();
      await request('readwrite', (s) => s.put({ buffer, info }, key));
      return info;
    },
    async get(key, options = {}) {
      options.signal?.throwIfAborted();
      const { buffer, info } = await get(key);
      return { ...info, body: new Blob([buffer]).stream() };
    },
    async head(key) {
      return (await get(key)).info;
    },
    async delete(key) {
      await request('readwrite', (s) => s.delete(key));
    },
  };
}

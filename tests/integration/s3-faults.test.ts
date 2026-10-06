// biome-ignore-all lint/suspicious/noExplicitAny: Heterogeneous command recorder used for deterministic SDK fault injection.
import type { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { createS3Storage } from '../../packages/storage/dist/s3.js';

const size = 5 * 1024 * 1024;
function deferred() {
  let complete = () => {};
  const promise = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return { promise, resolve: () => complete() };
}
function backend(
  fail?: (name: string, input: any, signal?: AbortSignal) => Promise<unknown> | unknown,
) {
  const calls: { name: string; input: any; signal?: AbortSignal }[] = [];
  const client = {
    async send(command: any, options: any) {
      const name = command.constructor.name;
      calls.push({ name, input: command.input, signal: options?.abortSignal });
      const response = await fail?.(name, command.input, options?.abortSignal);
      if (response) return response;
      if (name === 'CreateMultipartUploadCommand') return { UploadId: 'upload-1' };
      if (name === 'UploadPartCommand')
        return { ETag: `part-${command.input.PartNumber}`, ChecksumCRC32: 'checksum' };
      return { ETag: 'committed' };
    },
  } as unknown as S3Client;
  return {
    calls,
    storage: createS3Storage({
      client,
      bucket: 'assets',
      multipart: { partSize: size, concurrency: 3 },
    }),
  };
}
describe('S3 deterministic protocol failures', () => {
  it('S3-03: a source failure during an active part settles the request before abort', async () => {
    let source: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
        controller.enqueue(new Uint8Array(size));
      },
    });
    let active = 0;
    const { storage, calls } = backend(async (name) => {
      if (name === 'UploadPartCommand') {
        active++;
        source.error(new Error('midstream source failure'));
        await new Promise((resolve) => setTimeout(resolve, 15));
        active--;
        return { ETag: 'part' };
      }
      if (name === 'AbortMultipartUploadCommand') expect(active).toBe(0);
    });
    await expect(storage.put('source', stream)).rejects.toMatchObject({
      code: 'MULTIPART_UPLOAD_FAILED',
      cause: { message: 'midstream source failure' },
    });
    expect(calls.some((c) => c.name === 'AbortMultipartUploadCommand')).toBe(true);
    expect(calls.some((c) => c.name === 'CompleteMultipartUploadCommand')).toBe(false);
  });
  it('STORE-01: missing objects remain distinct from permission and network failures', async () => {
    for (const [status, code] of [
      [404, 'STORAGE_NOT_FOUND'],
      [403, 'STORAGE_PERMISSION_DENIED'],
      [503, 'STORAGE_IO_ERROR'],
    ] as const) {
      const { storage } = backend(() => {
        throw Object.assign(new Error('http failure'), { $metadata: { httpStatusCode: status } });
      });
      await expect(storage.get('key')).rejects.toMatchObject({ code });
      await expect(storage.head('key')).rejects.toMatchObject({ code });
    }
  });
  it('S3-02/06: checksum negotiation, invalid part sizing/count and bounded source read-ahead', async () => {
    let pulled = 0,
      active = 0;
    const gate = deferred();
    const started = deferred();
    const { storage, calls } = backend(async (name) => {
      if (name === 'CreateMultipartUploadCommand')
        return {
          UploadId: 'checksum-upload',
          ChecksumAlgorithm: 'CRC32',
          ChecksumType: 'COMPOSITE',
        };
      if (name === 'UploadPartCommand') {
        active++;
        if (active === 3) started.resolve();
        await gate.promise;
        active--;
        return { ETag: 'part', ChecksumCRC32: 'sum' };
      }
    });
    const upload = storage.put(
      'stream',
      new ReadableStream({
        pull(c) {
          if (++pulled <= 6) c.enqueue(new Uint8Array(size));
          else c.close();
        },
      }),
    );
    await started.promise;
    await new Promise((resolve) => setTimeout(resolve, 10));
    try {
      expect(active).toBe(3);
      expect(pulled).toBeLessThanOrEqual(4);
    } finally {
      gate.resolve();
    }
    await upload;
    expect(
      calls
        .filter((c) => c.name === 'UploadPartCommand')
        .every((c) => c.input.ChecksumAlgorithm === 'CRC32'),
    ).toBe(true);
    expect(calls.find((c) => c.name === 'CompleteMultipartUploadCommand')?.input.ChecksumType).toBe(
      'COMPOSITE',
    );
    expect(() =>
      createS3Storage({ client: {} as S3Client, bucket: 'assets', multipart: { partSize: 1 } }),
    ).toThrow();
    const unread = new ReadableStream<Uint8Array>();
    await expect(
      storage.put('oversize', unread, { contentLength: size * 10000 + 1 }),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
    await unread.cancel();
  });
  it('S3-03/04: settles in-flight parts before abort, preserves primary and cleanup error', async () => {
    let active = 0;
    const { storage, calls } = backend(async (name, input, signal) => {
      if (name === 'UploadPartCommand') {
        active++;
        try {
          if (input.PartNumber === 2) throw new Error('part failure');
          await new Promise((r) => setTimeout(r, 15));
          return { ETag: 'ok' };
        } finally {
          active--;
        }
      }
      if (name === 'AbortMultipartUploadCommand') {
        expect(active).toBe(0);
        expect(signal?.aborted).toBe(false);
        throw new Error('cleanup failed');
      }
    });
    await expect(storage.put('key', new Uint8Array(size * 4))).rejects.toMatchObject({
      code: 'MULTIPART_UPLOAD_FAILED',
      cleanupErrors: [expect.any(Error)],
      cause: expect.any(Error),
    });
    expect(calls.map((c) => c.name)).not.toContain('CompleteMultipartUploadCommand');
    expect(calls.map((c) => c.name)).not.toContain('DeleteObjectCommand');
  });
  it('S3-05: lost completion response reports unknown and never deletes the object', async () => {
    const { storage, calls } = backend((name) => {
      if (name === 'CompleteMultipartUploadCommand') throw new Error('response lost');
    });
    await expect(storage.put('key', new Uint8Array(1))).rejects.toMatchObject({
      code: 'COMMIT_OUTCOME_UNKNOWN',
      context: { uploadId: 'upload-1' },
    });
    expect(calls.map((c) => c.name)).not.toContain('DeleteObjectCommand');
  });
  it('S3-02/06: ordered completion, checksum propagation, bounded parallel requests and monotonic progress', async () => {
    let active = 0,
      peak = 0;
    const { storage, calls } = backend(async (name, input) => {
      if (name === 'UploadPartCommand') {
        peak = Math.max(peak, ++active);
        await new Promise((r) => setTimeout(r, input.PartNumber === 1 ? 15 : 1));
        active--;
        return { ETag: `part-${input.PartNumber}`, ChecksumCRC32: 'checked' };
      }
    });
    const progress: number[] = [];
    await storage.put('key', new Uint8Array(size * 4 + 1), {
      onProgress: (p) => progress.push(p.loaded),
    });
    expect(peak).toBeLessThanOrEqual(3);
    const complete = calls.find((c) => c.name === 'CompleteMultipartUploadCommand');
    expect(complete?.input.MultipartUpload.Parts.map((p: any) => p.PartNumber)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(complete?.input.MultipartUpload.Parts[0].ChecksumCRC32).toBe('checked');
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress.at(-1)).toBe(size * 4 + 1);
  });
  it('S3-03: cancellation uses a fresh cleanup signal', async () => {
    const controller = new AbortController();
    const { storage, calls } = backend((name) => {
      if (name === 'UploadPartCommand') controller.abort();
    });
    await expect(
      storage.put('key', new Uint8Array(2), { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    expect(calls.find((c) => c.name === 'AbortMultipartUploadCommand')?.signal?.aborted).toBe(
      false,
    );
  });
  it('S3-01: an empty part is attempted; unsupported backend is reported', async () => {
    const { storage, calls } = backend((name) => {
      if (name === 'UploadPartCommand')
        throw Object.assign(new Error('empty unsupported'), { $metadata: { httpStatusCode: 400 } });
    });
    await expect(storage.put('empty', new Uint8Array())).rejects.toMatchObject({
      code: 'STORAGE_CAPABILITY_UNSUPPORTED',
    });
    expect(calls.find((c) => c.name === 'UploadPartCommand')?.input.Body.length).toBe(0);
    expect(calls.map((c) => c.name)).not.toContain('PutObjectCommand');
  });
});

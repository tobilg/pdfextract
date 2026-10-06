// biome-ignore-all lint/suspicious/noExplicitAny: Fault injection middleware crosses AWS command input variants.
import { readdir, readFile, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { openPdf } from '@pdfextract/core';
import S3rver from 's3rver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StorageAdapter } from '../../packages/core/dist/index.js';
import { createFilesystemStorage } from '../../packages/storage/dist/filesystem.js';
import { createS3Storage } from '../../packages/storage/dist/s3.js';
import { temporaryDirectory } from '../helpers/temp.js';

let directory: string;
let server: InstanceType<typeof S3rver>;
let client: S3Client;
beforeAll(async () => {
  directory = await temporaryDirectory('pdfextract-storage-');
  server = new S3rver({
    directory: join(directory, 's3'),
    address: '127.0.0.1',
    port: 0,
    silent: true,
    configureBuckets: [{ name: 'assets', configs: [] }],
  });
  const address = await server.run();
  client = new S3Client({
    endpoint: `http://127.0.0.1:${address.port}`,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'S3RVER', secretAccessKey: 'S3RVER' },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
});
afterAll(async () => {
  client?.destroy();
  await server?.close();
  await rm(directory, { recursive: true, force: true });
});
const read = async (storage: StorageAdapter, key: string) =>
  new Uint8Array(await new Response((await storage.get(key)).body).arrayBuffer());
const body = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes.subarray(0, 1));
      c.enqueue(bytes.subarray(1));
      c.close();
    },
  });
for (const backend of ['filesystem', 's3'])
  describe(backend, () => {
    const adapter = () =>
      backend === 'filesystem'
        ? createFilesystemStorage({ directory: join(directory, 'fs') })
        : createS3Storage({
            client,
            bucket: 'assets',
            prefix: 'tests/',
            multipart: { partSize: 5 * 1024 * 1024, concurrency: 2 },
          });
    it('STORE-02: actual PDF, full PNG, thumbnail, structured JSON, plain text and empty bytes round-trip exactly', async () => {
      const source = await readFile('tests/fixtures/baseline.pdf');
      const pdf = await openPdf(source);
      try {
        const text = await pdf.getStructuredText(),
          [image] = await pdf.getImages();
        const full = await pdf.extractImage(image.id),
          thumb = await pdf.extractImage(image.id, { maxWidth: 1 });
        const payloads: [string, Uint8Array, string][] = [
          ['source.pdf', source, 'application/pdf'],
          ['full.png', full.data, 'image/png'],
          ['thumb.png', thumb.data, 'image/png'],
          ['text.json', new TextEncoder().encode(JSON.stringify(text)), 'application/json'],
          ['text.txt', new TextEncoder().encode(text.fullText), 'text/plain; charset=utf-8'],
          ['empty', new Uint8Array(), 'application/octet-stream'],
        ];
        const storage = adapter();
        for (const [name, bytes, contentType] of payloads) {
          const key = `types/${name}`;
          await storage.put(key, bytes, { contentType });
          expect(Buffer.from(await read(storage, key)).equals(Buffer.from(bytes))).toBe(true);
          expect((await storage.head(key)).contentType).toBe(contentType);
        }
      } finally {
        await pdf.close();
      }
    });
    it('STORE-01/02: bytes, streams, metadata, replacement, empty, missing and idempotent delete', async () => {
      const storage = adapter();
      const bytes = await readFile('tests/fixtures/baseline.pdf');
      const progress: number[] = [];
      await storage.put('document/source.pdf', bytes, {
        contentType: 'application/pdf',
        metadata: { source: 'fixture' },
        contentLength: bytes.length,
        onProgress: (p) => progress.push(p.loaded),
      });
      expect(await read(storage, 'document/source.pdf')).toEqual(new Uint8Array(bytes));
      expect(await adapter().head('document/source.pdf')).toMatchObject({
        key: 'document/source.pdf',
        size: bytes.length,
        contentType: 'application/pdf',
        metadata: { source: 'fixture' },
      });
      const replacement = Uint8Array.from([0, 255, 32, 10]);
      await storage.put('document/source.pdf', body(replacement), {
        contentType: 'application/octet-stream',
        metadata: { revision: '2' },
      });
      expect(await read(storage, 'document/source.pdf')).toEqual(replacement);
      await storage.put('document/empty.txt', new Uint8Array());
      expect(await read(storage, 'document/empty.txt')).toHaveLength(0);
      expect(progress).toEqual([...progress].sort((a, b) => a - b));
      await storage.delete('document/source.pdf');
      await storage.delete('document/source.pdf');
      await expect(storage.head('document/source.pdf')).rejects.toMatchObject({
        code: 'STORAGE_NOT_FOUND',
      });
    });
    it('FS-02 S3-04: source/length failures preserve the previous complete object', async () => {
      const storage = adapter();
      await storage.put('replace.bin', Uint8Array.from([7]), { metadata: { revision: 'old' } });
      const source = new ReadableStream<Uint8Array>({
        pull(c) {
          c.error(new Error('source failed'));
        },
      });
      await expect(storage.put('replace.bin', source)).rejects.toBeDefined();
      expect(await read(storage, 'replace.bin')).toEqual(Uint8Array.from([7]));
      expect((await storage.head('replace.bin')).metadata).toEqual({ revision: 'old' });
      await expect(
        storage.put('replace.bin', body(new Uint8Array(3)), { contentLength: 4 }),
      ).rejects.toMatchObject({ code: 'CONTENT_LENGTH_MISMATCH' });
      expect(await read(storage, 'replace.bin')).toEqual(Uint8Array.from([7]));
    });
    it('STORE-01 FS-01: portable key validation on every operation', async () => {
      const storage = adapter();
      for (const key of ['', '../escape', '/absolute', 'a/../b', 'a\\b', 'a//b', 'a\0b']) {
        await expect(storage.put(key, new Uint8Array())).rejects.toMatchObject({
          code: 'INVALID_STORAGE_KEY',
        });
        await expect(storage.get(key)).rejects.toMatchObject({ code: 'INVALID_STORAGE_KEY' });
        await expect(storage.head(key)).rejects.toMatchObject({ code: 'INVALID_STORAGE_KEY' });
        await expect(storage.delete(key)).rejects.toMatchObject({ code: 'INVALID_STORAGE_KEY' });
      }
    });
  });
it('FS-01: symlinks cannot read external bodies', async () => {
  const root = join(directory, 'symlinks'),
    storage = createFilesystemStorage({ directory: root });
  await storage.put('key', Uint8Array.from([1]));
  const file = (await readdir(root))[0];
  await rm(join(root, file));
  await symlink(resolve('tests/fixtures/baseline.pdf'), join(root, file));
  await expect(storage.get('key')).rejects.toMatchObject({ code: 'STORAGE_IO_ERROR' });
});
it('S3-01/02: actual multipart below/at/above boundaries and unknown streams', async () => {
  const commands: string[] = [];
  client.middlewareStack.add(
    (next, context) => async (args) => {
      commands.push(context.commandName ?? 'unknown');
      return next(args);
    },
    { step: 'initialize', name: 'recordCommands' },
  );
  const storage = createS3Storage({
    client,
    bucket: 'assets',
    multipart: { partSize: 5 * 1024 * 1024, concurrency: 3 },
  });
  for (const size of [1, 5 * 1024 * 1024, 5 * 1024 * 1024 + 1, 15 * 1024 * 1024 + 7]) {
    const bytes = new Uint8Array(size).fill(83);
    await storage.put(`multipart/${size}`, body(bytes));
    expect(Buffer.from(await read(storage, `multipart/${size}`)).equals(Buffer.from(bytes))).toBe(
      true,
    );
  }
  expect(commands).toContain('CreateMultipartUploadCommand');
  expect(commands).toContain('UploadPartCommand');
  expect(commands).toContain('CompleteMultipartUploadCommand');
  expect(commands).not.toContain(PutObjectCommand.name);
});

it('S3-06: real SDK retries replay identical bytes without inflating progress', async () => {
  let attempts = 0;
  const replayed: Buffer[] = [];
  client.middlewareStack.addRelativeTo(
    (next: (args: any) => Promise<any>, context: { commandName?: string }) => async (args: any) => {
      if (context.commandName === 'UploadPartCommand') {
        replayed.push(Buffer.from((args.input as { Body: Uint8Array }).Body));
        if (++attempts === 1)
          throw Object.assign(new Error('injected transient response'), {
            $metadata: { httpStatusCode: 503 },
            $retryable: {},
          });
      }
      return next(args);
    },
    { name: 'oneTransientPart', relation: 'after', toMiddleware: 'retryMiddleware' },
  );
  try {
    const storage = createS3Storage({ client, bucket: 'assets' });
    const progress: number[] = [];
    await storage.put('retry.bin', Uint8Array.from([7, 42, 128]), {
      onProgress: (p) => progress.push(p.loaded),
    });
    expect(attempts).toBe(2);
    expect(replayed[0].equals(replayed[1])).toBe(true);
    expect(progress).toEqual([3, 3]);
    expect(await read(storage, 'retry.bin')).toEqual(Uint8Array.from([7, 42, 128]));
  } finally {
    client.middlewareStack.remove('oneTransientPart');
  }
});

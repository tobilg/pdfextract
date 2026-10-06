import { readFile, rm } from 'node:fs/promises';
import { PdfExtractError, type StorageAdapter } from '@pdfextract/core';
import { createFilesystemStorage } from '@pdfextract/storage/filesystem';
import { expect, it } from 'vitest';
import {
  extractAndStore,
  readManifest,
  selectStoredImage,
  validateExtractionManifest,
} from '../../examples/shared/persistence.js';
import { temporaryDirectory } from '../helpers/temp.js';

it('FLOW-01/02 STORE-02: manifest-last and exact stored File in a fresh adapter', async () => {
  const directory = await temporaryDirectory('pdfextract-flow-');
  const storage = createFilesystemStorage({ directory }),
    keys: string[] = [];
  const traced: StorageAdapter = {
    ...storage,
    async put(key, body, options) {
      keys.push(key);
      return storage.put(key, body, options);
    },
  };
  try {
    const result = await extractAndStore(await readFile('tests/fixtures/baseline.pdf'), traced);
    expect(keys.at(-1)).toBe(result.manifestKey);
    const fresh = createFilesystemStorage({ directory });
    const manifest = await readManifest(fresh, result.manifestKey);
    let callback: File | undefined;
    const selected = await selectStoredImage(fresh, manifest, manifest.images[0].id, (file) => {
      callback = file;
    });
    expect(callback).toBe(selected);
    const stored = await new Response(
      (await storage.get(manifest.images[0].fullSizeKey)).body,
    ).arrayBuffer();
    expect(Buffer.from(await selected.arrayBuffer()).equals(Buffer.from(stored))).toBe(true);
    expect(() =>
      validateExtractionManifest({
        ...manifest,
        images: [{ ...manifest.images[0], fullSizeKey: '../escape' }],
      }),
    ).toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it('FLOW-01: failed assets do not publish a manifest and only this run is cleaned', async () => {
  const directory = await temporaryDirectory('pdfextract-flow-fail-'),
    storage = createFilesystemStorage({ directory });
  await storage.put('unrelated/keep', new Uint8Array([1]));
  let manifestAttempted = false;
  const failing: StorageAdapter = {
    ...storage,
    async put(key, body, options) {
      if (key.endsWith('manifest.json')) manifestAttempted = true;
      if (key.endsWith('thumbnail.png')) throw new Error('asset failure');
      return storage.put(key, body, options);
    },
  };
  try {
    await expect(
      extractAndStore(await readFile('tests/fixtures/baseline.pdf'), failing),
    ).rejects.toMatchObject({ details: { published: false, orphanedKeys: [] } });
    expect(manifestAttempted).toBe(false);
    expect((await storage.head('unrelated/keep')).size).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it('FLOW-01 S3-05: uncertain manifest commit preserves all referenced assets', async () => {
  const directory = await temporaryDirectory('pdfextract-flow-unknown-'),
    storage = createFilesystemStorage({ directory }),
    deletes: string[] = [];
  const uncertain: StorageAdapter = {
    ...storage,
    async put(key, body, options) {
      const result = await storage.put(key, body, options);
      if (key.endsWith('manifest.json'))
        throw new PdfExtractError('COMMIT_OUTCOME_UNKNOWN', 'Lost completion response');
      return result;
    },
    async delete(key) {
      deletes.push(key);
      await storage.delete(key);
    },
  };
  try {
    await expect(
      extractAndStore(await readFile('tests/fixtures/baseline.pdf'), uncertain),
    ).rejects.toMatchObject({
      details: {
        commitOutcomeUnknown: true,
        orphanedKeys: expect.arrayContaining([expect.stringMatching(/manifest.json$/)]),
      },
    });
    expect(deletes).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

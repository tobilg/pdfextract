import type { ImageOccurrence, OpenPdfOptions, PdfInput, StorageAdapter } from '@pdfextract/core';
import { checkAbort, openPdf, PdfExtractError } from '@pdfextract/core';
export interface StoredImage {
  id: string;
  width: number;
  height: number;
  mimeType: 'image/png';
  fullSizeKey: string;
  thumbnailKey: string;
  occurrences: ImageOccurrence[];
  sha256: string;
}
export interface ExtractionManifest {
  schemaVersion: 1;
  documentId: string;
  pageCount: number;
  sourceKey: string;
  structuredTextKey: string;
  plainTextKey: string;
  images: StoredImage[];
}
export class PersistenceError extends Error {
  constructor(
    message: string,
    public readonly details: {
      manifestKey: string;
      createdKeys: string[];
      orphanedKeys: string[];
      cleanupErrors: unknown[];
      commitOutcomeUnknown: boolean;
      published: boolean;
    },
    cause: unknown,
  ) {
    super(message, { cause });
    this.name = 'PersistenceError';
  }
}
const keyPattern = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*(?:\/[a-zA-Z0-9_][a-zA-Z0-9_.-]*)*$/;
export function validateExtractionManifest(value: unknown): ExtractionManifest {
  const invalid = () => {
    throw new PdfExtractError('INVALID_ARGUMENT', 'Invalid extraction manifest');
  };
  if (!value || typeof value !== 'object') return invalid();
  const v = value as Record<string, unknown>;
  if (
    v.schemaVersion !== 1 ||
    typeof v.documentId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(v.documentId) ||
    !Number.isSafeInteger(v.pageCount) ||
    (v.pageCount as number) < 1 ||
    !Array.isArray(v.images)
  )
    return invalid();
  const key = (k: unknown) =>
    typeof k === 'string' &&
    k.length <= 1024 &&
    keyPattern.test(k) &&
    k.startsWith(`${v.documentId}/`);
  if (!key(v.sourceKey) || !key(v.structuredTextKey) || !key(v.plainTextKey)) return invalid();
  const ids = new Set<string>(),
    keys = new Set([v.sourceKey, v.structuredTextKey, v.plainTextKey]);
  const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
  const box = (b: unknown) =>
    !!b &&
    typeof b === 'object' &&
    ['x', 'y', 'width', 'height'].every((k) => finite((b as Record<string, unknown>)[k])) &&
    (b as { width: number }).width >= 0 &&
    (b as { height: number }).height >= 0;
  for (const image of v.images) {
    if (
      !image ||
      typeof image !== 'object' ||
      typeof image.id !== 'string' ||
      !image.id ||
      ids.has(image.id) ||
      image.mimeType !== 'image/png' ||
      !Number.isSafeInteger(image.width) ||
      image.width < 1 ||
      !Number.isSafeInteger(image.height) ||
      image.height < 1 ||
      !key(image.fullSizeKey) ||
      !key(image.thumbnailKey) ||
      image.fullSizeKey === image.thumbnailKey ||
      keys.has(image.fullSizeKey) ||
      keys.has(image.thumbnailKey) ||
      typeof image.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(image.sha256) ||
      !Array.isArray(image.occurrences)
    )
      return invalid();
    ids.add(image.id);
    keys.add(image.fullSizeKey);
    keys.add(image.thumbnailKey);
    for (const o of image.occurrences) {
      if (
        !o ||
        typeof o.occurrenceId !== 'string' ||
        !Number.isSafeInteger(o.pageNumber) ||
        o.pageNumber < 1 ||
        o.pageNumber > (v.pageCount as number) ||
        !box(o.bbox) ||
        !Array.isArray(o.imageToPage) ||
        o.imageToPage.length !== 6 ||
        !o.imageToPage.every(finite) ||
        typeof o.clipped !== 'boolean'
      )
        return invalid();
    }
  }
  return structuredClone(value) as ExtractionManifest;
}
export async function sha256(bytes: Uint8Array) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
export async function extractAndStore(
  input: PdfInput,
  storage: StorageAdapter,
  options: OpenPdfOptions = {},
) {
  const documentId = crypto.randomUUID(),
    manifestKey = `${documentId}/manifest.json`,
    createdKeys: string[] = [],
    attemptedKeys: string[] = [];
  let published = false,
    unknown = false;
  let pdf: Awaited<ReturnType<typeof openPdf>> | undefined;
  let result: { manifestKey: string; manifest: ExtractionManifest } | undefined;
  let failure: PersistenceError | undefined;
  const put = async (
    key: string,
    bytes: Uint8Array | ReadableStream<Uint8Array>,
    contentType: string,
  ) => {
    checkAbort(options.signal);
    attemptedKeys.push(key);
    await storage.put(key, bytes, { contentType, signal: options.signal });
    createdKeys.push(key);
  };
  const json = (key: string, value: unknown) =>
    put(key, new TextEncoder().encode(JSON.stringify(value)), 'application/json');
  try {
    const sourceKey = `${documentId}/source.pdf`;
    await put(
      sourceKey,
      input instanceof Blob
        ? input.stream()
        : input instanceof ArrayBuffer
          ? new Uint8Array(input)
          : input,
      'application/pdf',
    );
    pdf = await openPdf(input, options);
    const text = await pdf.getStructuredText({
      signal: options.signal,
      onProgress: options.onProgress,
    });
    if (text.status !== 'complete') throw new Error('Persistence requires complete extraction');
    const manifest: ExtractionManifest = {
      schemaVersion: 1,
      documentId,
      pageCount: pdf.pageCount,
      sourceKey,
      structuredTextKey: `${documentId}/text/structured.json`,
      plainTextKey: `${documentId}/text/plain.txt`,
      images: [],
    };
    await json(manifest.structuredTextKey, text);
    await put(
      manifest.plainTextKey,
      new TextEncoder().encode(text.fullText),
      'text/plain; charset=utf-8',
    );
    const images = await pdf.getImages(options);
    for (const [index, image] of images.entries()) {
      const full = await pdf.extractImage(image.id, options),
        fullSizeKey = `${documentId}/images/${index}/full.png`,
        thumbnailKey = `${documentId}/images/${index}/thumbnail.png`;
      await put(fullSizeKey, full.data, full.mimeType);
      const hash = await sha256(full.data);
      const thumbnail = await pdf.extractImage(image.id, {
        ...options,
        maxWidth: 320,
        maxHeight: 240,
      });
      await put(thumbnailKey, thumbnail.data, thumbnail.mimeType);
      manifest.images.push({
        id: image.id,
        width: full.width,
        height: full.height,
        mimeType: 'image/png',
        fullSizeKey,
        thumbnailKey,
        sha256: hash,
        occurrences: [...image.occurrences],
      });
    }
    validateExtractionManifest(manifest);
    await json(manifestKey, manifest);
    published = true;
    result = { manifestKey, manifest };
  } catch (error) {
    unknown = error instanceof PdfExtractError && error.code === 'COMMIT_OUTCOME_UNKNOWN';
    const orphanedKeys: string[] = [],
      cleanupErrors: unknown[] = [];
    if (!unknown && !published)
      for (const key of attemptedKeys.reverse())
        try {
          await storage.delete(key, { signal: AbortSignal.timeout(10000) });
        } catch (e) {
          orphanedKeys.push(key);
          cleanupErrors.push(e);
        }
    else orphanedKeys.push(...attemptedKeys);
    failure = new PersistenceError(
      unknown
        ? 'Publication outcome unknown; inspect the manifest before deleting any assets'
        : 'Extraction was not published',
      {
        manifestKey,
        createdKeys,
        orphanedKeys,
        cleanupErrors,
        commitOutcomeUnknown: unknown,
        published,
      },
      error,
    );
  }
  try {
    await pdf?.close();
  } catch (error) {
    if (failure) failure.details.cleanupErrors.push(error);
    else
      failure = new PersistenceError(
        'Extraction published; document cleanup failed',
        {
          manifestKey,
          createdKeys,
          orphanedKeys: [],
          cleanupErrors: [error],
          commitOutcomeUnknown: false,
          published,
        },
        error,
      );
  }
  if (failure) throw failure;
  if (!result) throw new Error('Missing persistence result');
  return result;
}

export async function readManifest(storage: StorageAdapter, key: string, signal?: AbortSignal) {
  const object = await storage.get(key, { signal });
  return validateExtractionManifest(await new Response(object.body).json());
}
export async function readBlob(storage: StorageAdapter, key: string, signal?: AbortSignal) {
  const object = await storage.get(key, { signal });
  return new Response(object.body, {
    headers: { 'Content-Type': object.contentType ?? 'application/octet-stream' },
  }).blob();
}
export async function selectStoredImage(
  storage: StorageAdapter,
  manifest: ExtractionManifest,
  imageId: string,
  host: (file: File) => Promise<void> | void,
  signal?: AbortSignal,
) {
  const image = manifest.images.find((i) => i.id === imageId);
  if (!image) throw new PdfExtractError('IMAGE_NOT_FOUND', 'Image is absent from the manifest');
  const blob = await readBlob(storage, image.fullSizeKey, signal),
    bytes = new Uint8Array(await blob.arrayBuffer());
  if ((await sha256(bytes)) !== image.sha256)
    throw new PdfExtractError('STORAGE_IO_ERROR', 'Stored full-size image fingerprint mismatch');
  checkAbort(signal);
  const file = new File([bytes], `${image.id}.png`, { type: image.mimeType });
  await host(file);
  return file;
}

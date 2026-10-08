import { S3Client } from '@aws-sdk/client-s3';
import { PdfExtractError, type PdfLimits, type StorageAdapter } from '@pdfextract/core';
import { createTesseractOcr } from '@pdfextract/ocr';
import { createS3Storage } from '@pdfextract/storage/s3';
import {
  type ExtractionManifest,
  extractAndStore,
  PersistenceError,
  readBlob,
  readManifest,
  selectStoredImage,
  sha256,
} from '../shared/persistence.js';
import { createDemoStorage } from './demo-storage.js';
import './style.css';

declare global {
  interface Window {
    pdfextractHost?: {
      storage?: StorageAdapter;
      limits?: PdfLimits;
      /** Optional minimum image width/height in pixels; smaller images are not stored. */
      minImageWidth?: number;
      minImageHeight?: number;
      loadImage?: (file: File) => Promise<void> | void;
    };
    pdfextractS3?: {
      endpoint: string;
      region: string;
      bucket: string;
      prefix: string;
      credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
    };
  }
}
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = element('status'),
  text = element('text'),
  gallery = element('gallery'),
  manifestInput = element<HTMLInputElement>('manifest');
let controller = new AbortController();
const urls: string[] = [];
let busy = false;
const storage =
  window.pdfextractHost?.storage ??
  (window.pdfextractS3
    ? createS3Storage({
        client: new S3Client({
          ...window.pdfextractS3,
          forcePathStyle: true,
          requestChecksumCalculation: 'WHEN_REQUIRED',
          responseChecksumValidation: 'WHEN_REQUIRED',
        }),
        bucket: window.pdfextractS3.bucket,
        prefix: window.pdfextractS3.prefix,
      })
    : createDemoStorage());
const host =
  window.pdfextractHost?.loadImage ??
  (async (file: File) => {
    element('selected').textContent =
      `Host callback: ${file.name}, ${file.size} bytes, SHA-256 ${await sha256(new Uint8Array(await file.arrayBuffer()))}`;
    window.dispatchEvent(new CustomEvent('pdfextract:selected', { detail: file }));
  });
function clear() {
  for (const url of urls) URL.revokeObjectURL(url);
  urls.length = 0;
  gallery.replaceChildren();
}
async function show(manifest: ExtractionManifest) {
  clear();
  text.textContent = await (
    await readBlob(storage, manifest.plainTextKey, controller.signal)
  ).text();
  for (const image of manifest.images) {
    const blob = await readBlob(storage, image.thumbnailKey, controller.signal),
      url = URL.createObjectURL(blob);
    urls.push(url);
    const button = document.createElement('button'),
      img = document.createElement('img'),
      label = document.createElement('span');
    img.src = url;
    img.alt = `Embedded image ${image.width} by ${image.height} pixels`;
    label.textContent = `${image.width} × ${image.height} · select full image`;
    button.append(img, label);
    button.onclick = () =>
      run(async () => {
        await selectStoredImage(storage, manifest, image.id, host, controller.signal);
        status.textContent = 'Stored full-size File passed to host callback.';
      });
    gallery.append(button);
  }
}
async function run(task: () => Promise<void>) {
  if (busy) return;
  busy = true;
  element<HTMLInputElement>('pdf').disabled = true;
  element<HTMLButtonElement>('load').disabled = true;
  try {
    await task();
  } catch (error) {
    status.textContent = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    if (error instanceof PersistenceError) {
      if (error.cause instanceof PdfExtractError)
        status.textContent += ` (${error.cause.code}: ${error.cause.message})`;
      if (error.details.orphanedKeys.length)
        status.textContent += ` Keys needing review: ${error.details.orphanedKeys.join(', ')}`;
    }
  } finally {
    busy = false;
    element<HTMLInputElement>('pdf').disabled = false;
    element<HTMLButtonElement>('load').disabled = false;
  }
}
element<HTMLInputElement>('pdf').onchange = () =>
  run(async () => {
    const file = element<HTMLInputElement>('pdf').files?.[0];
    if (!file) return;
    controller.abort();
    controller = new AbortController();
    status.textContent = 'Extracting…';
    clear();
    const base = new URL(import.meta.env.BASE_URL, location.origin);
    const ocr = element<HTMLInputElement>('ocr').checked
      ? createTesseractOcr({
          languages: ['eng', 'deu'],
          assets: {
            workerUrl: new URL('pdfextract/ocr/worker.min.js', base),
            coreBaseUrl: new URL('pdfextract/ocr/core/', base),
            languageDataBaseUrl: new URL('pdfextract/languages/', base),
          },
        })
      : undefined;
    try {
      const result = await extractAndStore(file, storage, {
        ocr,
        limits: window.pdfextractHost?.limits,
        minWidth: window.pdfextractHost?.minImageWidth,
        minHeight: window.pdfextractHost?.minImageHeight,
        signal: controller.signal,
        onProgress: (e) => {
          status.textContent = `${e.stage}: ${e.completed}/${e.total ?? '?'}`;
        },
        assets: {
          baseUrl: new URL('pdfextract/core/', base),
          workerUrl: new URL('pdfextract/core/pdf.worker.mjs', base),
          wasmUrl: new URL('pdfextract/core/wasm/', base),
        },
      });
      manifestInput.value = result.manifestKey;
      localStorage.setItem('pdfextract:last-manifest', result.manifestKey);
      await show(result.manifest);
      const ignored = result.manifest.ignoredImageCount ?? 0;
      status.textContent = `Extraction stored. Select an image or reload and load its manifest.${
        ignored ? ` ${ignored} smaller ${ignored === 1 ? 'image was' : 'images were'} ignored.` : ''
      }`;
    } finally {
      await ocr?.close();
    }
  });
element('load').onclick = () =>
  run(async () => {
    controller.abort();
    controller = new AbortController();
    await show(await readManifest(storage, manifestInput.value, controller.signal));
    status.textContent = 'Loaded stored images without opening the PDF.';
  });
element('cancel').onclick = () => controller.abort();
manifestInput.value = localStorage.getItem('pdfextract:last-manifest') ?? '';
window.addEventListener('pagehide', () => {
  controller.abort();
  clear();
});

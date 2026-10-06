import type { S3Client } from '@aws-sdk/client-s3';
import type { StorageAdapter } from '@pdfextract/core';
import { createS3Storage } from '@pdfextract/storage/s3';

/** The host owns endpoint configuration, temporary credentials, authorization and client cleanup. */
export const remoteStorage = (client: S3Client) =>
  createS3Storage({
    client,
    bucket: 'pdf-assets',
    prefix: 'extractions/',
    multipart: { mode: 'always', partSize: 8 * 1024 * 1024, concurrency: 3 },
  });

/** Retrieve the stored export without parsing the PDF or re-encoding the image. */
export async function selectStoredImage(
  storage: StorageAdapter,
  fullSizeKey: string,
  loadImage: (file: File) => void | Promise<void>,
  signal?: AbortSignal,
) {
  const object = await storage.get(fullSizeKey, { signal });
  const bytes = await new Response(object.body).arrayBuffer();
  await loadImage(new File([bytes], 'selected.png', { type: object.contentType ?? 'image/png' }));
}

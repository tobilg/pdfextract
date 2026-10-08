import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createTesseractOcr } from '@pdfextract/ocr';
import { createFilesystemStorage } from '@pdfextract/storage/filesystem';
import { extractAndStore, readManifest, selectStoredImage } from '../shared/persistence.js';

const [command = 'extract', path = 'tests/fixtures/mixed.pdf', directory = './pdf-assets'] =
  process.argv.slice(2);
const storage = createFilesystemStorage({ directory: resolve(directory) }),
  controller = new AbortController();
process.once('SIGINT', () => controller.abort());
// Optional minimum image size in pixels; smaller images are not stored. Unset means unfiltered.
const size = (name: string) => (process.env[name] ? Number(process.env[name]) : undefined);
if (command === 'extract') {
  const languagePath = process.env.PDFEXTRACT_LANGUAGE_PATH;
  const ocr = languagePath
    ? createTesseractOcr({ languages: ['eng'], assets: { languageDataBaseUrl: languagePath } })
    : undefined;
  try {
    const result = await extractAndStore(await readFile(path), storage, {
      ocr,
      minWidth: size('PDFEXTRACT_MIN_IMAGE_WIDTH'),
      minHeight: size('PDFEXTRACT_MIN_IMAGE_HEIGHT'),
      signal: controller.signal,
      onProgress: (event) =>
        process.stderr.write(`${event.stage}: ${event.completed}/${event.total ?? '?'}\n`),
    });
    console.log(result.manifestKey);
  } finally {
    await ocr?.close();
  }
} else if (command === 'load') {
  const manifest = await readManifest(storage, path, controller.signal);
  console.log(
    `${manifest.pageCount} pages, ${manifest.images.length} stored images, ` +
      `${manifest.ignoredImageCount ?? 0} ignored by the minimum size`,
  );
  if (manifest.images[0])
    await selectStoredImage(
      storage,
      manifest,
      manifest.images[0].id,
      (file) => {
        console.log(`Host callback received ${file.name}, ${file.size} authoritative bytes`);
      },
      controller.signal,
    );
} else
  throw new Error(
    'Usage: pnpm example:node extract <pdf> <directory> | load <manifest-key> <directory>',
  );

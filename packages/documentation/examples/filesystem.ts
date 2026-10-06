import { realpath } from 'node:fs/promises';
import { createFilesystemStorage } from '@pdfextract/storage/filesystem';

/** Node-only: this example expects an existing private root directory. */
export async function localStorage(directory: string) {
  return createFilesystemStorage({ directory: await realpath(directory) });
}

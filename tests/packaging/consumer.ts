import { S3Client } from '@aws-sdk/client-s3';
import { type OcrProvider, openPdf, type StorageAdapter } from '@pdfextract/core';
import { createTesseractOcr } from '@pdfextract/ocr';
import { createFilesystemStorage } from '@pdfextract/storage/filesystem';
import { createS3Storage } from '@pdfextract/storage/s3';

const provider: OcrProvider = createTesseractOcr({ languages: ['eng'] });
const filesystem: StorageAdapter = createFilesystemStorage({ directory: './objects' });
const s3: StorageAdapter = createS3Storage({
  client: new S3Client({ region: 'us-east-1' }),
  bucket: 'example',
});
void openPdf;
void provider;
void filesystem;
void s3;

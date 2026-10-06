import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { temporaryDirectory } from '../helpers/temp.js';

const S3rver = createRequire(import.meta.url)('s3rver') as typeof import('s3rver');
let server: InstanceType<typeof S3rver>;
let directory: string;
let endpoint: string;
test.beforeAll(async () => {
  directory = await temporaryDirectory('pdfextract-browser-s3-');
  const cors = Buffer.from(
    '<CORSConfiguration><CORSRule><AllowedOrigin>http://127.0.0.1:4173</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedMethod>POST</AllowedMethod><AllowedMethod>DELETE</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><ExposeHeader>x-amz-version-id</ExposeHeader><ExposeHeader>x-amz-checksum-crc32</ExposeHeader></CORSRule></CORSConfiguration>',
  );
  server = new S3rver({
    directory,
    port: 0,
    address: '127.0.0.1',
    silent: true,
    configureBuckets: [{ name: 'assets', configs: [cors] }],
  });
  const address = await server.run();
  endpoint = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  await server?.close();
  await rm(directory, { recursive: true, force: true });
});
test('FLOW-01/02 S3-01 E2E-01: real service, authorized host configuration and CORS', async ({
  page,
}) => {
  await page.addInitScript(
    (config) => {
      window.pdfextractS3 = config;
    },
    {
      endpoint,
      region: 'us-east-1',
      bucket: 'assets',
      prefix: `${crypto.randomUUID()}/`,
      credentials: { accessKeyId: 'S3RVER', secretAccessKey: 'S3RVER' },
    },
  );
  const uploads: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('uploadId='))
      uploads.push(request.url());
  });
  await page.goto('./');
  await page.locator('#pdf').setInputFiles(resolve('tests/fixtures/scan.pdf'));
  await expect(page.locator('#status')).toContainText('Extraction stored', { timeout: 30000 });
  expect(uploads.length).toBe(6);
  expect(uploads.at(-1)).toContain('manifest.json');
  await page.locator('#gallery button').click();
  await expect(page.locator('#selected')).toContainText('SHA-256');
  const original = await page.locator('#selected').innerText();
  await page.reload();
  await page.locator('#load').click();
  await expect(page.locator('#status')).toContainText('without opening the PDF');
  await page.locator('#gallery button').click();
  await expect(page.locator('#selected')).toHaveText(original);
});

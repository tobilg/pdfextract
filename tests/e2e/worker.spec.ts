import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

test('WORKER-01: extraction, PNG export and OCR run inside a dedicated Web Worker', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto('./worker.html');
  const status = page.locator('#status'),
    text = page.locator('#text'),
    input = page.locator('#pdf');

  await page.locator('#ocr').selectOption('auto');
  await input.setInputFiles(resolve('tests/fixtures/mixed.pdf'));
  await expect(status).toContainText('Done in worker (DOM: false)', { timeout: 90000 });
  await expect(status).toContainText('PNG ok');
  await expect(text).toContainText('Native paragraph');
  await expect(text).toContainText('RASTER');

  // Full-page OCR renders the page with OffscreenCanvas, since workers have no document.
  await page.locator('#ocr').selectOption('always');
  await input.setInputFiles(resolve('tests/fixtures/scan.pdf'));
  await expect(status).toContainText('Done in worker (DOM: false)', { timeout: 90000 });
  await expect(text).toContainText('Deutsche Karte Berlin');
  expect(errors).toEqual([]);
});

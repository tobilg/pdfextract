import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { decode } from 'fast-png';
import { galleryFixture, outlinedFixture } from './gallery-fixture.mjs';

const fixture = (name: string) => resolve('../../tests/fixtures', name);

test('CORE-02 OCR-01 OCR-05: vector lettering needs whole-page OCR, not embedded-image OCR', async ({
  page,
}) => {
  await page.goto('./');
  await page.getByLabel('Recognize scanned text (OCR)').check();
  await page.locator('#pdf-file').setInputFiles({
    name: 'outlined-lettering.pdf',
    mimeType: 'application/pdf',
    buffer: outlinedFixture(),
  });
  await expect(page.getByRole('status').first()).toContainText('Extraction complete');
  await expect(page.locator('.result-summary')).toContainText('0 text characters');
  await expect(page.locator('.images-panel')).toContainText('no embedded raster images');
  await expect(
    page.getByRole('complementary', { name: 'Whole-page OCR suggestion' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Recognize whole pages', exact: true }).click();
  await expect(page.getByRole('status').first()).toContainText('Extraction complete', {
    timeout: 90_000,
  });
  await expect(page.getByTestId('reading')).toContainText('VECTOR TEXT 7429');
  await expect(page.getByLabel('OCR coverage')).toHaveValue('always');
  await expect(page.getByRole('complementary', { name: 'Whole-page OCR suggestion' })).toHaveCount(
    0,
  );
  await page.getByLabel('Text page').selectOption({ label: '2' });
  await expect(page.getByTestId('reading')).toContainText('VECTOR TEXT 7429');
  await page.getByRole('button', { name: 'Page JSON' }).click();
  await expect(page.getByTestId('page-json')).toContainText('"source": "ocr"');
  await expect(page.locator('.images-panel')).toContainText('no embedded raster images');
});

test('CORE-04 PERF-01: password recovery and page navigation on a 150-page PDF', async ({
  page,
}) => {
  await page.goto('./');
  await page.locator('#pdf-file').setInputFiles(fixture('password.pdf'));
  await expect(page.getByRole('alert')).toContainText('PASSWORD_REQUIRED');
  await page.getByLabel('Password (optional)', { exact: true }).fill('wrong');
  await page.getByRole('button', { name: 'Extract again' }).click();
  await expect(page.getByRole('alert')).toContainText('INVALID_PASSWORD');
  await page.getByLabel('Password (optional)', { exact: true }).fill('fixture-pass');
  await page.getByRole('button', { name: 'Extract again' }).click();
  await expect(page.getByRole('status').first()).toContainText('Extraction complete');
  await expect(page.getByTestId('reading')).toContainText('PASSWORD SENTINEL');
  await page.locator('#pdf-file').setInputFiles(fixture('150-pages.pdf'));
  await expect(page.getByRole('status').first()).toContainText('Extraction complete');
  await page.getByLabel('Text page').selectOption({ label: '150' });
  await expect(page.getByTestId('reading')).toHaveText('Page 150');
  await expect(page.locator('.images-panel')).toContainText('no embedded raster images');
});

test('IMG-04 PERF-02: gallery pagination only retains the current thumbnails', async ({ page }) => {
  await page.goto('./');
  await page.locator('#pdf-file').setInputFiles({
    name: 'nine-images.pdf',
    mimeType: 'application/pdf',
    buffer: galleryFixture(),
  });
  await expect(page.getByRole('status').first()).toContainText('Extraction complete');
  await expect(page.locator('.image-preview img')).toHaveCount(8);
  const previous = await page
    .locator('.image-preview img')
    .evaluateAll((images) => images.map((image) => (image as HTMLImageElement).src));
  await page.getByRole('button', { name: 'Next images' }).click();
  await expect(page.locator('.image-preview img')).toHaveCount(1);
  await expect(page.locator('.image-card')).toContainText('Image 9');
  expect(
    await page.evaluate(
      async (urls) =>
        Promise.all(
          urls.map(async (url) => {
            try {
              await fetch(url);
              return false;
            } catch {
              return true;
            }
          }),
        ),
      previous,
    ),
  ).toEqual(Array(8).fill(true));
  await page.getByRole('button', { name: 'Previous images' }).click();
  await expect(page.locator('.image-preview img')).toHaveCount(8);
});

test('E2E-01 CORE-02 CORE-03 IMG-02: structured text, native pixels, downloads and memory-only reset', async ({
  page,
}) => {
  const errors: string[] = [];
  const transfers: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() !== 'GET') transfers.push(request.url());
  });
  await page.addInitScript(() => {
    const active = new Set<string>();
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      active.add(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      active.delete(url);
      revoke(url);
    };
    Object.assign(window, { demoActiveUrls: active });
  });
  await page.goto('./');
  await page.locator('#pdf-file').setInputFiles(fixture('baseline.pdf'));
  await expect(page.getByRole('status').first()).toContainText('Extraction complete');
  await expect(page.getByTestId('reading')).toContainText('Native café');
  await expect(page.locator('.image-card')).toHaveCount(2);
  await expect(page.locator('.image-preview img')).toHaveCount(2);
  await page.getByRole('button', { name: 'Structure', exact: true }).click();
  await page.locator('.structure summary').first().click();
  await expect(page.locator('.span').first()).toContainText('native');
  await page.getByRole('button', { name: 'Page JSON' }).click();
  await expect(page.getByTestId('page-json')).toContainText('"bbox"');
  const jsonEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download JSON' }).click();
  const jsonPath = await (await jsonEvent).path();
  if (!jsonPath) throw new Error('Missing downloaded JSON file');
  const json = JSON.parse(await readFile(jsonPath, 'utf8'));
  expect(json.schemaVersion).toBe(1);
  expect(json.fullText).toContain('Native café');
  const pngEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download full PNG' }).first().click();
  const pngPath = await (await pngEvent).path();
  if (!pngPath) throw new Error('Missing downloaded PNG file');
  const png = decode(await readFile(pngPath));
  expect([png.width, png.height]).toEqual([2, 2]);
  expect(Array.from(png.data)).toEqual([
    255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 255, 255, 0, 255,
  ]);
  await page.getByRole('button', { name: 'Clear PDF' }).click();
  await expect(page.locator('.image-card')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { demoActiveUrls: Set<string> }).demoActiveUrls.size,
      ),
    )
    .toBe(0);
  await page.reload();
  await expect(page.getByRole('status')).toContainText('Choose a PDF');
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  expect(transfers).toEqual([]);
  expect(errors).toEqual([]);
});

test('OCR-01 OCR-02 OCR-05: real OCR on mixed and scanned PDFs with same-origin assets', async ({
  page,
}) => {
  const remote: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:4177/') && !request.url().startsWith('blob:'))
      remote.push(request.url());
  });
  await page.goto('./');
  await page.getByLabel('Recognize scanned text (OCR)').check();
  await page.locator('#pdf-file').setInputFiles(fixture('mixed.pdf'));
  await expect(page.getByRole('status').first()).toContainText('Extraction complete', {
    timeout: 90_000,
  });
  await expect(page.getByTestId('reading')).toContainText('Native paragraph');
  await expect(page.getByTestId('reading')).toContainText('RASTER');
  await page.getByRole('button', { name: 'Page JSON' }).click();
  await expect(page.getByTestId('page-json')).toContainText('"source": "ocr"');
  await page.locator('#pdf-file').setInputFiles(fixture('scan.pdf'));
  await expect(page.getByRole('status').first()).toContainText('Extraction complete', {
    timeout: 90_000,
  });
  await expect(page.getByTestId('page-json')).toContainText('RASTER');
  expect(remote).toEqual([]);
});

test('CORE-04 PERF-02: cancel a real engine load, reject corrupt PDFs, and recover', async ({
  page,
}) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((accept) => {
    release = accept;
  });
  let intercepted: () => void = () => {};
  const started = new Promise<void>((accept) => {
    intercepted = accept;
  });
  await page.route('**/pdfextract/core/pdf.mjs', async (route) => {
    intercepted();
    await gate;
    await route.continue();
  });
  await page.goto('./');
  await page.locator('#pdf-file').setInputFiles(fixture('150-pages.pdf'));
  await started;
  await page.getByRole('button', { name: 'Cancel extraction' }).click();
  await expect(page.getByRole('status')).toContainText('cancelled');
  release();
  await page.unrouteAll({ behavior: 'wait' });
  await page.locator('#pdf-file').setInputFiles(fixture('corrupt.pdf'));
  await expect(page.getByRole('alert')).toContainText('INVALID_PDF');
  await page.locator('#pdf-file').setInputFiles(fixture('baseline.pdf'));
  await expect(page.getByRole('status').first()).toContainText('Extraction complete');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('IMG-01: full export retains native dimensions; mobile layout fits', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await page.locator('#pdf-file').setInputFiles(fixture('large-small.pdf'));
  await expect(page.getByRole('status').first()).toContainText('Extraction complete');
  await expect(page.locator('.image-card')).toContainText('4096 × 2048');
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download full PNG' }).click();
  const pngPath = await (await event).path();
  if (!pngPath) throw new Error('Missing downloaded PNG file');
  const png = decode(await readFile(pngPath));
  expect([png.width, png.height]).toEqual([4096, 2048]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { decode } from 'fast-png';
import {
  brokenTextFixture,
  galleryFixture,
  outlinedFixture,
  overlayFixture,
  tableFixture,
} from './gallery-fixture.mjs';

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

test('IMG-06: a minimum image size skips small images and the summary counts them', async ({
  page,
}) => {
  await page.goto('./');
  await page.getByLabel('Minimum image width').fill('2');
  await page.getByLabel('Minimum image height').fill('2');
  // baseline.pdf holds a 2×2 and a 1×1 image.
  await page.locator('#pdf-file').setInputFiles(fixture('baseline.pdf'));
  await expect(page.getByRole('status').first()).toContainText('Extraction complete');
  await expect(page.locator('.result-summary')).toContainText('1 embedded image');
  await expect(page.locator('.result-summary')).toContainText('1 smaller image ignored');
  await expect(page.locator('.image-card')).toHaveCount(1);
  // Clearing the filter lists every image again.
  await page.getByLabel('Minimum image width').fill('');
  await page.getByLabel('Minimum image height').fill('');
  await page.getByRole('button', { name: 'Extract again' }).click();
  await expect(page.locator('.result-summary')).toContainText('2 embedded images');
  await expect(page.locator('.result-summary')).not.toContainText('ignored');
});

test('TABLE-01: table detection is off by default and shows tables when enabled', async ({
  page,
}) => {
  await page.goto('./');
  await expect(page.getByLabel('Detect tables')).not.toBeChecked();
  const file = { name: 'table.pdf', mimeType: 'application/pdf', buffer: tableFixture() };
  await page.locator('#pdf-file').setInputFiles(file);
  await expect(page.getByRole('status').first()).toContainText('Extraction complete');
  await expect(page.getByRole('button', { name: 'Tables', exact: true })).toHaveCount(0);
  await expect(page.locator('.result-summary')).not.toContainText('table');
  await page.getByLabel('Detect tables').check();
  await page.getByRole('button', { name: 'Extract again' }).click();
  await expect(page.getByRole('status').first()).toContainText('Extraction complete');
  await expect(page.locator('.result-summary')).toContainText('1 table');
  await expect(page.getByTestId('reading')).toContainText('Bolt\t12\t0.40');
  await page.getByRole('button', { name: 'Tables', exact: true }).click();
  const table = page.getByTestId('tables');
  await expect(table.locator('figcaption')).toContainText('3 × 3 · ruling lines');
  await expect(table.locator('tr')).toHaveCount(3);
  await expect(table.locator('tr').nth(1).locator('td')).toHaveText(['Bolt', '12', '0.40']);
});

test('COMP-01: composite images are off by default and include overlays when enabled', async ({
  page,
}) => {
  await page.goto('./');
  await expect(page.getByLabel('Show images with overlays (as on the page)')).not.toBeChecked();
  await expect(page.getByLabel('Include annotations')).toHaveCount(0);
  const file = { name: 'overlay.pdf', mimeType: 'application/pdf', buffer: overlayFixture() };
  await page.locator('#pdf-file').setInputFiles(file);
  await expect(page.getByRole('status').first()).toContainText('Extraction complete');
  await expect(page.locator('.image-card')).toContainText('overlaid');
  await expect(page.locator('.image-preview img')).toHaveCount(1);
  await expect(page.locator('.badge')).toHaveCount(0);
  await page.getByLabel('Show images with overlays (as on the page)').check();
  await expect(page.getByLabel('Include annotations')).not.toBeChecked();
  await page.getByRole('button', { name: 'Extract again' }).click();
  await expect(page.getByRole('status').first()).toContainText('Extraction complete');
  await expect(page.locator('.badge')).toHaveText('Composite: with content drawn above');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download full PNG' }).click();
  const event = await download;
  expect(event.suggestedFilename()).toBe('image-1-40x20-composite.png');
  const path = await event.path();
  if (!path) throw new Error('Missing downloaded PNG file');
  const png = decode(await readFile(path));
  const pixel = (x: number, y: number) =>
    Array.from(png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 4));
  // Blue square over the red raster; untouched areas stay red (canvas tolerance).
  expect(pixel(15, 10).map((v, i) => Math.abs(v - [0, 0, 255, 255][i]) <= 3)).toEqual([
    true,
    true,
    true,
    true,
  ]);
  expect(pixel(2, 2).map((v, i) => Math.abs(v - [255, 0, 0, 255][i]) <= 3)).toEqual([
    true,
    true,
    true,
    true,
  ]);
});

test('DEGRADED-01 CLIP-01: broken page content is reported with images, and clipped images marked', async ({
  page,
}) => {
  await page.goto('./');
  await page.locator('#pdf-file').setInputFiles({
    name: 'broken-text.pdf',
    mimeType: 'application/pdf',
    buffer: brokenTextFixture(),
  });
  await expect(page.getByRole('status').first()).toContainText(
    'Extraction finished with warnings.',
  );
  // Both images are listed despite page 1's broken text operator.
  const cards = page.locator('.image-card');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText('Page 1');
  // The badge, not the placement JSON (which lists "clipped" for every image).
  await expect(cards.nth(0)).toContainText('· clipped');
  await expect(cards.nth(1)).toContainText('Page 2');
  await expect(cards.nth(1)).not.toContainText('· clipped');
  // Text and image-list warnings share the panel.
  const warnings = page.locator('details.warnings');
  await expect(warnings.locator('summary')).toHaveText('2 extraction warnings');
  await warnings.locator('summary').click();
  await expect(warnings).toContainText('Page 1:');
  await expect(warnings).toContainText('(TEXT_EXTRACTION_FAILED)');
  await expect(warnings).toContainText('(IMAGE_INVENTORY_DEGRADED)');
  await page.getByLabel('Text page').selectOption({ label: '2' });
  await expect(page.getByTestId('reading')).toContainText('Intact page');
});

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { decode } from 'fast-png';

test('E2E-01 IMG-02: browser exports owned masked/color-managed PNGs against independent expectations', async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.pdfextractHost = {
      loadImage: async (file) => {
        (window as unknown as { selectedBytes: number[] }).selectedBytes = Array.from(
          new Uint8Array(await file.arrayBuffer()),
        );
      },
    };
  });
  await page.goto('./');
  await page.locator('#pdf').setInputFiles(resolve('tests/fixtures/baseline.pdf'));
  await expect(page.locator('#status')).toContainText('Extraction stored');
  await page.locator('#gallery button').first().click();
  await expect(page.locator('#status')).toContainText('passed to host');
  const read = () =>
    page.evaluate(() => (window as unknown as { selectedBytes: number[] }).selectedBytes);
  expect(Array.from(decode(Uint8Array.from(await read())).data)).toEqual([
    255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 255, 255, 0, 255,
  ]);
  await page.locator('#pdf').setInputFiles(resolve('tests/fixtures/colors.pdf'));
  await expect(page.locator('#status')).toContainText('Extraction stored');
  await page.locator('#gallery button').nth(7).click();
  await expect(page.locator('#status')).toContainText('passed to host');
  const rgba = decode(Uint8Array.from(await read())).data;
  const reference = JSON.parse(
    await readFile('tests/fixtures/color-reference.json', 'utf8'),
  ).displayP3;
  let index = 0;
  for (let i = 0; i < rgba.length; i++)
    if (i % 4 !== 3) expect(Math.abs(rgba[i] - reference[index++])).toBeLessThanOrEqual(2);
});

test('PERF-02: configured browser image budget rejects 40 MP without producing a reduced export', async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.pdfextractHost = { limits: { maxImagePixels: 16_000_000 } };
  });
  await page.goto('./');
  await page.locator('#pdf').setInputFiles(resolve('tests/fixtures/40-megapixels.pdf'));
  await expect(page.locator('#status')).toContainText('RESOURCE_LIMIT_EXCEEDED');
  await expect(page.locator('#gallery button')).toHaveCount(0);
  await expect(page.locator('#manifest')).toHaveValue('');
});

test('E2E-01 FLOW-01/02: whole PDF gallery, real OCR, full File and later-session retrieval', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  await page.goto('./');
  await page.locator('#ocr').check();
  await page.locator('#pdf').setInputFiles(resolve('tests/fixtures/mixed.pdf'));
  await expect(page.locator('#status')).toContainText('Extraction stored', { timeout: 90000 });
  await expect(page.locator('#text')).toContainText('Native paragraph');
  await expect(page.locator('#text')).toContainText('RASTER');
  await expect(page.locator('#gallery button')).toHaveCount(1);
  await page.locator('#gallery button').click();
  await expect(page.locator('#selected')).toContainText('SHA-256');
  const selected = await page.locator('#selected').innerText();
  const manifestKey = await page.locator('#manifest').inputValue();
  expect(manifestKey).toMatch(/\/manifest.json$/);
  await page.reload();
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.locator('#load').click();
  await expect(page.locator('#status')).toContainText('without opening the PDF');
  await page.locator('#gallery button').click();
  await expect(page.locator('#selected')).toHaveText(selected);
  expect(requests.filter((url) => /pdf\.mjs|pdf\.worker|\.wasm|traineddata/.test(url))).toEqual([]);
  expect(errors).toEqual([]);
});
test('E2E-01 IMG-01/02/03/04: native-size large export and mask/inline inventory', async ({
  page,
}) => {
  await page.goto('./');
  await page.locator('#pdf').setInputFiles(resolve('tests/fixtures/baseline.pdf'));
  await expect(page.locator('#status')).toContainText('Extraction stored');
  await expect(page.locator('#gallery button')).toHaveCount(2);
  await expect(page.locator('#text')).toContainText('Native café');
  await page.locator('#pdf').setInputFiles(resolve('tests/fixtures/large-small.pdf'));
  await expect(page.locator('#status')).toContainText('Extraction stored');
  await expect(page.locator('#gallery button')).toContainText('4096 × 2048');
  await page.locator('#gallery button').click();
  await expect(page.locator('#selected')).toContainText('SHA-256');
});

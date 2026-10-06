import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = join(root, 'packages/documentation/dist');
const prefix = '/api/';
const origin = 'https://documentation.invalid';
const files = await readdir(output, { recursive: true });
const pages = files.filter((file) => file.endsWith('.html'));
assert(pages.length >= 50, 'Expected API pages for all three public packages and their guides');
const html = new Map(
  await Promise.all(
    pages.map(async (file) => [resolve(output, file), await readFile(join(output, file), 'utf8')]),
  ),
);
async function localPath(pathname) {
  assert(pathname.startsWith(prefix), `Link escaped the hosting base: ${pathname}`);
  let path = resolve(output, decodeURIComponent(pathname.slice(prefix.length)));
  assert(path === output || path.startsWith(output + sep), 'Path escaped the output directory');
  if ((await stat(path)).isDirectory()) path = join(path, 'index.html');
  return path;
}
let links = 0;
const sourcePackages = new Set();
for (const [file, content] of html) {
  assert(!content.includes('{@includeCode'), `Unexpanded example: ${file}`);
  const base = new URL(prefix + relative(output, file), origin);
  for (const [, raw] of content.matchAll(/(?:href|src)="([^"]*)"/g)) {
    if (!raw || /^(?:data|mailto):/.test(raw)) continue;
    const url = new URL(raw.replaceAll('&amp;', '&'), base);
    if (url.origin !== origin) {
      const source = url.href.match(
        /^https:\/\/github\.com\/tobilg\/pdfextract\/blob\/main\/packages\/(core|ocr|storage)\/src\//,
      );
      if (source) sourcePackages.add(source[1]);
      continue;
    }
    const path = await localPath(url.pathname);
    assert((await stat(path)).isFile(), `Missing local target: ${url.href}`);
    if (url.hash && path.endsWith('.html'))
      assert(
        html.get(path)?.includes(`id="${decodeURIComponent(url.hash.slice(1))}"`),
        `Missing anchor: ${url.href}`,
      );
    links++;
  }
}
assert.deepEqual([...sourcePackages].sort(), ['core', 'ocr', 'storage']);
for (const [file, phrase] of [
  ['core/dist/contracts.d.ts', 'Owned PNG bytes'],
  ['ocr/dist/index.d.ts', 'Create a reusable OCR provider'],
  ['storage/dist/s3.d.ts', 'Create strict multipart storage'],
]) {
  assert(
    (await readFile(join(root, 'packages', file), 'utf8')).includes(phrase),
    `Public declaration lost its API comments: ${file}`,
  );
}
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
};
const server = createServer(async (request, response) => {
  try {
    const path = await localPath(new URL(request.url, origin).pathname);
    response.setHeader('Content-Type', mime[extname(path)] ?? 'application/octet-stream');
    createReadStream(path)
      .on('error', () => response.destroy())
      .pipe(response);
  } catch {
    response.writeHead(404).end('Not found');
  }
});
let browser;
try {
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  const base = `http://127.0.0.1:${server.address().port}${prefix}`;
  browser = await chromium.launch();
  const page = await browser.newPage();
  const failures = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(base);
  await expect(page.getByRole('heading', { name: 'pdfextract API', exact: true })).toBeVisible();
  await expect(page.locator('.col-content h1')).toHaveCount(1);
  await page.getByRole('link', { name: 'Getting started', exact: true }).first().click();
  await expect(page.locator('pre').filter({ hasText: 'extractNative' })).toBeVisible();
  await page.locator('#tsd-search-trigger').click();
  await page.locator('#tsd-search-input').fill('openPdf');
  const result = page.locator('#tsd-search-results a').filter({ hasText: 'openPdf' }).first();
  await expect(result).toBeVisible();
  await result.click();
  await expect(page).toHaveURL(/\/_pdfextract\/core\/openPdf\//);
  for (const route of [
    'core/PdfDocument',
    'ocr/createTesseractOcr',
    'storage/filesystem/createFilesystemStorage',
    'storage/s3/createS3Storage',
  ]) {
    await page.goto(`${base}_pdfextract/${route}/`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(route.split('/').at(-1));
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base);
  await expect(page.getByRole('heading', { name: 'pdfextract API', exact: true })).toBeVisible();
  assert.deepEqual(failures, [], 'Browser console/network errors');
  const report = {
    pages: pages.length,
    localLinksAndAssets: links,
    sourcePackages: [...sourcePackages].sort(),
    browser: browser.version(),
    basePath: prefix,
    navigation: 'passed',
    search: 'passed',
    embeddedExamples: 'passed',
    declarationComments: 'passed',
  };
  await mkdir(join(root, 'artifacts/reports'), { recursive: true });
  await writeFile(
    join(root, 'artifacts/reports/documentation-validation.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((accept) => server.close(accept));
}

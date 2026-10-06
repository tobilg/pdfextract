import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'vite';

const root = process.cwd();
for (const name of process.argv[2] ? [process.argv[2]] : ['core', 'ocr', 'storage']) {
  const dir = resolve(root, 'packages', name);
  const entry =
    name === 'core'
      ? { index: resolve(dir, 'src/index.ts'), 'index-node': resolve(dir, 'src/index-node.ts') }
      : name === 'storage'
        ? {
            index: resolve(dir, 'src/index.ts'),
            filesystem: resolve(dir, 'src/filesystem.ts'),
            s3: resolve(dir, 'src/s3.ts'),
          }
        : name === 'ocr'
          ? { index: resolve(dir, 'src/index.ts'), 'index-node': resolve(dir, 'src/index-node.ts') }
          : { index: resolve(dir, 'src/index.ts') };
  await build({
    configFile: false,
    build: {
      outDir: resolve(dir, 'dist'),
      emptyOutDir: true,
      sourcemap: true,
      minify: false,
      lib: { entry, formats: ['es'], fileName: (_format, name) => `${name}.js` },
      rollupOptions: {
        external: (id) =>
          id.startsWith('node:') ||
          (!id.startsWith('.') && !id.startsWith('/') && !id.startsWith('\0')),
      },
    },
  });
  const tsc = spawnSync('pnpm', ['exec', 'tsc', '-p', resolve(dir, 'tsconfig.json')], {
    stdio: 'inherit',
  });
  if (tsc.status) process.exit(tsc.status);
}
const dest = 'packages/core/dist/assets';
await mkdir(dest, { recursive: true });
await build({
  configFile: false,
  build: {
    outDir: resolve(dest),
    emptyOutDir: false,
    sourcemap: true,
    minify: false,
    lib: { entry: resolve('scripts/png-encoder.ts'), formats: ['es'], fileName: () => 'png.mjs' },
  },
});
for (const [from, to] of [
  ['legacy/build/pdf.mjs', 'pdf.mjs'],
  ['cmaps', 'cmaps'],
  ['standard_fonts', 'standard_fonts'],
  ['wasm', 'wasm'],
  ['iccs', 'iccs'],
])
  await cp(`node_modules/pdfjs-dist/${from}`, `${dest}/${to}`, { recursive: true });
let display = await readFile(`${dest}/pdf.mjs`, 'utf8');
const canvasStart = display.indexOf('if (isNodeJS) {\n  let canvas;');
const canvasEnd = display.indexOf('\nasync function node_utils_fetchData', canvasStart);
if (canvasStart < 0 || canvasEnd < canvasStart) throw new Error('PDF.js canvas patch anchor drift');
display = `${display.slice(0, canvasStart)}// pdfextract initializes native canvas only for explicit Node page rendering.\n${display.slice(canvasEnd)}`;
for (const [needle, replacement] of [
  ['const SCALE_MATRIX = new DOMMatrix();', 'let SCALE_MATRIX;'],
  [
    '    SCALE_MATRIX.a = 1 / scaleX;',
    '    SCALE_MATRIX ??= new DOMMatrix();\n    SCALE_MATRIX.a = 1 / scaleX;',
  ],
]) {
  if (display.split(needle).length !== 2)
    throw new Error(`PDF.js canvas patch anchor drift: ${needle}`);
  display = display.replace(needle, replacement);
}
await writeFile(`${dest}/pdf.mjs`, display.replace(/\/\/# sourceMappingURL=.*$/m, ''));
let worker = (await readFile('node_modules/pdfjs-dist/build/pdf.worker.mjs', 'utf8')).replace(
  /\/\/# sourceMappingURL=.*$/m,
  '',
);
function replaceOnce(needle, value) {
  if (worker.split(needle).length !== 2) throw new Error(`PDF.js patch anchor drift: ${needle}`);
  worker = worker.replace(needle, value);
}
replaceOnce(
  'function fetchSync(url) {',
  `function fetchSync(url) {\n const local = pdfextractSyncAssets.get(url.split('/').pop()); if (local) return local;`,
);
replaceOnce(
  '    handler.on("GetData", function (data) {',
  `    handler.on("PdfextractConfigure", data => pdfextractConfigure(data));
    handler.on("PdfextractImages", async data => {
      try { return {value: await pdfextractScan(pdfManager, handler, data)}; }
      catch (error) { return {error: String(error?.message ?? error)}; }
    });
    handler.on("GetData", function (data) {`,
);
worker += `\n${await readFile('packages/core/src/engine-extension.js', 'utf8')}`;
await writeFile(`${dest}/pdf.worker.mjs`, worker);
await cp('packages/core/src/node-worker-bootstrap.mjs', `${dest}/node-worker-bootstrap.mjs`);
await mkdir('packages/core/THIRD_PARTY_NOTICES', { recursive: true });
await cp('node_modules/pdfjs-dist/LICENSE', 'packages/core/THIRD_PARTY_NOTICES/PDFJS-LICENSE');
await mkdir('packages/ocr/dist/assets', { recursive: true });
// Keep the upstream parser/OCR engines intact. This pinned factory patch exposes
// startup cancellation and propagates the otherwise swallowed initialization error.
function patchTesseract(source) {
  const patches = [
    [
      '  worker.onerror = workerError;',
      `  worker.onerror = workerError;
  if (worker.on) worker.on('error', workerError);
  options.onWorker?.(worker, reason => {
    workerResReject(reason);
    for (const job of Object.values(promises)) job.reject(reason);
  });`,
    ],
    ['.catch(() => {});', '.catch(workerResReject);'],
    [
      'const workerError = (event) => { workerResReject(event.message); };',
      'const workerError = (event) => { workerResReject(event.message); for (const job of Object.values(promises)) job.reject(event.message); };',
    ],
  ];
  for (const [needle, replacement] of patches) {
    if (source.split(needle).length !== 2)
      throw new Error(`Tesseract patch anchor drift: ${needle}`);
    source = source.replace(needle, replacement);
  }
  return source;
}
await build({
  configFile: false,
  plugins: [
    {
      name: 'pdfextract-tesseract-lifecycle',
      enforce: 'pre',
      transform(code, id) {
        if (id.endsWith('/tesseract.js/src/createWorker.js')) return patchTesseract(code);
      },
    },
  ],
  build: {
    outDir: resolve('packages/ocr/dist/assets'),
    emptyOutDir: false,
    sourcemap: false,
    minify: false,
    lib: {
      entry: resolve('scripts/tesseract-entry.ts'),
      formats: ['es'],
      fileName: () => 'tesseract.mjs',
    },
  },
});
// Bundle the Node factory and worker so the published OCR package needs neither tesseract.js
// nor its 40+ MB tesseract.js-core dependency at runtime. Node 22 always provides fetch.
async function bundleNode(entry, fileName, transform) {
  await build({
    configFile: false,
    logLevel: 'warn',
    plugins: [
      {
        name: 'pdfextract-tesseract-node',
        enforce: 'pre',
        resolveId(id) {
          if (id === 'node-fetch') return '\0node-fetch';
          // The worker uses tesseract.js's own feature detection dependency.
          if (id === 'wasm-feature-detect')
            return createRequire(require.resolve('tesseract.js')).resolve(id);
        },
        load: (id) => (id === '\0node-fetch' ? 'module.exports = globalThis.fetch;' : undefined),
        transform,
      },
    ],
    ssr: { noExternal: true, target: 'node' },
    build: {
      ssr: entry,
      outDir: resolve('packages/ocr/dist/assets'),
      emptyOutDir: false,
      sourcemap: false,
      minify: false,
      rollupOptions: { output: { format: 'cjs', entryFileNames: fileName } },
    },
  });
}
const require = createRequire(import.meta.url);
const createWorkerPath = require.resolve('tesseract.js/src/createWorker.js');
await bundleNode(createWorkerPath, 'tesseract-node.cjs', (code, id) => {
  if (id !== createWorkerPath) return;
  const anchor = '  let worker = spawnWorker(options);';
  const patched = patchTesseract(code);
  if (patched.split(anchor).length !== 2)
    throw new Error(`Tesseract patch anchor drift: ${anchor}`);
  return patched.replace(
    anchor,
    `  for (const field of ['langPath', 'workerPath', 'corePath']) {
    if (options[field]?.startsWith('file:')) options[field] = require('node:url').fileURLToPath(options[field]);
  }
${anchor}`,
  );
});
await bundleNode(resolve('packages/ocr/src/node-worker.cjs'), 'node-worker.cjs');
await cp('node_modules/tesseract.js/dist/worker.min.js', 'packages/ocr/dist/assets/worker.min.js');
// Recognition always uses OEM 1 (LSTM only), so only the -lstm cores can ever load: the
// .wasm.js single-file builds for browsers, the .js + .wasm pairs for Node.
const coreDir = resolve(
  createRequire(require.resolve('tesseract.js/package.json')).resolve(
    'tesseract.js-core/package.json',
  ),
  '..',
);
await mkdir('packages/ocr/dist/assets/core', { recursive: true });
const coreFiles = (await readdir(coreDir)).filter(
  (file) =>
    file === 'LICENSE' ||
    /^tesseract-core(-simd|-relaxedsimd)?-lstm\.(js|wasm|wasm\.js)$/.test(file),
);
if (coreFiles.length !== 10) throw new Error(`Unexpected tesseract.js-core files: ${coreFiles}`);
for (const file of coreFiles)
  await cp(resolve(coreDir, file), `packages/ocr/dist/assets/core/${file}`);
// The Emscripten .js cores are CommonJS; the OCR package itself is "type": "module".
await writeFile('packages/ocr/dist/assets/core/package.json', '{ "type": "commonjs" }\n');
console.log(
  'Built three packages, declarations, PDF.js worker/codecs/fonts and OCR worker/core assets.',
);

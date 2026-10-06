// Tesseract's Node adapter with explicit self-hosted core-directory support.
const { parentPort } = require('node:worker_threads');
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const worker = require('tesseract.js/src/worker-script');
const fromTesseract = createRequire(require.resolve('tesseract.js'));
const { simd, relaxedSimd } = fromTesseract('wasm-feature-detect');
const defaultCore = require('tesseract.js/src/worker-script/node/getCore');
let core;
parentPort.on('message', (packet) =>
  worker.dispatchHandlers(packet, (data) => parentPort.postMessage(data)),
);
worker.setAdapter({
  fetch: globalThis.fetch,
  gunzip: require('tesseract.js/src/worker-script/node/gunzip'),
  ...require('tesseract.js/src/worker-script/node/cache'),
  async getCore(oem, directory, progress) {
    if (!directory) return defaultCore(oem, directory, progress);
    if (!core) {
      progress.progress({ status: 'loading tesseract core', progress: 0 });
      const acceleration = (await relaxedSimd()) ? '-relaxedsimd' : (await simd()) ? '-simd' : '';
      const lstm = [1, 3].includes(oem) ? '-lstm' : '';
      core = require(resolve(directory, `tesseract-core${acceleration}${lstm}.js`));
      progress.progress({ status: 'loading tesseract core', progress: 1 });
    }
    return core;
  },
});

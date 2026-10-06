// Tesseract's Node worker adapter, bundled at build time so the published package has no
// runtime dependency on tesseract.js or tesseract.js-core. Only the LSTM cores are shipped:
// recognition always uses OEM 1 (LSTM only).
const { parentPort } = require('node:worker_threads');
const { resolve } = require('node:path');
const worker = require('tesseract.js/src/worker-script');
const { simd, relaxedSimd } = require('wasm-feature-detect');
let core;
parentPort.on('message', (packet) =>
  worker.dispatchHandlers(packet, (data) => parentPort.postMessage(data)),
);
worker.setAdapter({
  fetch: globalThis.fetch,
  gunzip: require('tesseract.js/src/worker-script/node/gunzip'),
  ...require('tesseract.js/src/worker-script/node/cache'),
  async getCore(_oem, directory, progress) {
    if (!core) {
      progress.progress({ status: 'loading tesseract core', progress: 0 });
      const acceleration = (await relaxedSimd()) ? '-relaxedsimd' : (await simd()) ? '-simd' : '';
      core = require(
        resolve(directory || resolve(__dirname, 'core'), `tesseract-core${acceleration}-lstm.js`),
      );
      progress.progress({ status: 'loading tesseract core', progress: 1 });
    }
    return core;
  },
});

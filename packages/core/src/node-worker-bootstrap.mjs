import { parentPort, workerData } from 'node:worker_threads';

const { WorkerMessageHandler } = await import(workerData?.workerUrl ?? './pdf.worker.mjs');

const listeners = new Map();
const port = {
  postMessage(data, transfers) {
    parentPort.postMessage(data, transfers);
  },
  addEventListener(type, listener) {
    if (type === 'message') {
      const wrapper = (data) => listener({ data });
      listeners.set(listener, wrapper);
      parentPort.on('message', wrapper);
    }
  },
  removeEventListener(type, listener) {
    if (type === 'message') {
      parentPort.off('message', listeners.get(listener));
      listeners.delete(listener);
    }
  },
};
WorkerMessageHandler.initializeFromPort(port);

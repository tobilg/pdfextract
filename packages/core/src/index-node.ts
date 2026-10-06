import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Worker as NodeWorker } from 'node:worker_threads';
import { setRuntime } from './engine.js';

const require = createRequire(import.meta.url);
setRuntime({
  worker(base, workerUrl) {
    const worker = new NodeWorker(new URL('node-worker-bootstrap.mjs', base), {
      // Assets are plain ESM: host loaders and CLI-only V8 flags are irrelevant.
      execArgv: [],
      workerData: { workerUrl },
    });
    const listeners = new Map<EventListener, (data: unknown) => void>();
    const errors = new Map<EventListener, (error: Error) => void>();
    return {
      postMessage(data: unknown, transfers: readonly import('node:worker_threads').Transferable[]) {
        worker.postMessage(data, transfers);
      },
      addEventListener(type: string, listener: EventListener) {
        if (type === 'message') {
          const wrapper = (data: unknown) => listener({ data } as MessageEvent);
          listeners.set(listener, wrapper);
          worker.on('message', wrapper);
        } else if (type === 'error') {
          const wrapper = (error: Error) => listener({ message: error.message } as ErrorEvent);
          errors.set(listener, wrapper);
          worker.on('error', wrapper);
        }
      },
      removeEventListener(type: string, listener: EventListener) {
        const wrapper = listeners.get(listener);
        if (type === 'message' && wrapper) {
          worker.off('message', wrapper);
          listeners.delete(listener);
        } else if (type === 'error') {
          const wrapper = errors.get(listener);
          if (wrapper) worker.off('error', wrapper);
          errors.delete(listener);
        }
      },
      terminate() {
        return worker.terminate();
      },
    };
  },
  async read(url, signal) {
    if (url.protocol === 'file:') return new Uint8Array(await readFile(url, { signal }));
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error(`Asset HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  },
  canvas(width, height) {
    const native = require('@napi-rs/canvas');
    const globals = globalThis as unknown as Record<string, unknown>;
    for (const name of ['DOMMatrix', 'ImageData', 'Path2D']) globals[name] ??= native[name];
    const canvas = native.createCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  },
});

export * from './index.js';

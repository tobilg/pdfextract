import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Worker as NodeWorker } from 'node:worker_threads';
import { setRuntime } from './engine.js';
import { PdfExtractError } from './errors.js';

const require = createRequire(import.meta.url);
/**
 * Engine workers start by compiling the PDF.js worker module, a large part of a small
 * document's time. Idle workers wait for the next document: one started ahead while a document
 * is read, and ones released by documents that closed cleanly (up to two, each serving at most
 * 100 documents). Failed or aborted documents end their worker. Idle workers do not keep the
 * process alive.
 */
interface Idle {
  key: string;
  worker: NodeWorker;
  /** Documents served. */
  uses: number;
  failed: boolean;
}
const idle: Idle[] = [];
const MAX_IDLE = 2,
  MAX_USES = 100;
function spawn(bootstrap: URL, workerUrl: string, key: string): Idle {
  const worker = new NodeWorker(bootstrap, {
    // Assets are plain ESM: host loaders and CLI-only V8 flags are irrelevant.
    execArgv: [],
    workerData: { workerUrl },
  });
  const entry: Idle = { key, worker, uses: 0, failed: false };
  // An idle worker that fails or ends is dropped; one in use reports through the engine.
  const drop = () => {
    entry.failed = true;
    const i = idle.indexOf(entry);
    if (i >= 0) idle.splice(i, 1);
  };
  worker.once('error', drop);
  worker.once('exit', drop);
  worker.unref();
  return entry;
}
setRuntime({
  platform: 'node',
  worker(base, workerUrl) {
    const bootstrap = new URL('node-worker-bootstrap.mjs', base),
      key = `${bootstrap.href}\n${workerUrl}`;
    // The most recently released worker first; one is started ahead when none is left.
    const index = idle.findLastIndex((e) => e.key === key);
    const entry = index >= 0 ? idle.splice(index, 1)[0] : spawn(bootstrap, workerUrl, key);
    entry.uses++;
    const worker = entry.worker;
    worker.ref();
    setImmediate(() => {
      if (!idle.some((e) => e.key === key)) idle.push(spawn(bootstrap, workerUrl, key));
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
          const wrapper = (error: Error) =>
            listener({ message: error.message, error } as ErrorEvent);
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
      async release() {
        for (const wrapper of listeners.values()) worker.off('message', wrapper);
        for (const wrapper of errors.values()) worker.off('error', wrapper);
        listeners.clear();
        errors.clear();
        if (entry.failed || entry.uses >= MAX_USES || idle.length >= MAX_IDLE)
          await worker.terminate();
        else {
          worker.unref();
          idle.push(entry);
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
    let native: ReturnType<typeof require>;
    try {
      native = require('@napi-rs/canvas');
    } catch (cause) {
      throw new PdfExtractError(
        'OCR_ASSET_UNAVAILABLE',
        "Page rendering in Node (full-page OCR with ocr: 'always', composite image export) needs the optional peer dependency @napi-rs/canvas; install it with `npm install @napi-rs/canvas`",
        { cause },
      );
    }
    const globals = globalThis as unknown as Record<string, unknown>;
    for (const name of ['DOMMatrix', 'ImageData', 'Path2D']) globals[name] ??= native[name];
    const canvas = native.createCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  },
});

export * from './index.js';

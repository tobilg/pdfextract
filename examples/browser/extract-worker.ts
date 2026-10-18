// Runs the complete extraction inside a dedicated module worker, where no DOM exists.
import { type ExtractRequest, type ExtractResponse, extract } from './extract.js';

export type { ExtractRequest, ExtractResponse };

self.onmessage = async ({ data }: MessageEvent<ExtractRequest>) => {
  self.postMessage(await extract(data));
};

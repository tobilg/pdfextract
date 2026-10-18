// Private PDF.js worker internals that src/engine-extension/ uses once scripts/build.mjs has
// appended it to the pinned worker. Only the extension's type check (tsconfig.engine.json) loads
// this file, so these globals never reach the public sources. Engine objects stay `any`; the
// operator argument layouts the extension reads are described where it reads them.
declare global {
  /** Operator codes of the pinned engine. */
  const OPS: Record<string, number>;
  /** Path opcodes inside constructPath buffers (checked by scripts/build.mjs). */
  const DrawOPS: { moveTo: number; lineTo: number; curveTo: number; closePath: number };
  const ImageKind: { RGBA_32BPP: number };
  // biome-ignore lint/suspicious/noExplicitAny: Engine-private classes.
  type EngineClass = any;
  const PartialEvaluator: EngineClass;
  const OperatorList: EngineClass;
  const WorkerTask: EngineClass;
  const PDFImage: EngineClass;
  const Name: EngineClass;
  const Ref: EngineClass;
  const IccColorSpace: EngineClass;
  const CmykICCBasedCS: EngineClass;
  const QCMS: EngineClass;
  function initSync(options: { module: unknown }): unknown;
  /** fast-png's encoder, imported by scripts/build.mjs from the bundled png.mjs. */
  function pdfextractEncodePng(image: {
    width: number;
    height: number;
    data: Uint8Array;
    channels: number;
  }): Uint8Array;
}

export {};

// Plain Node import boundary: a filesystem consumer must not load these engines/SDKs.
export async function resolve(specifier, context, next) {
  if (/tesseract|@aws-sdk|pdf\.mjs|pdf\.worker|@napi-rs\/canvas/.test(specifier))
    throw new Error(`PACK-02 unwanted filesystem import: ${specifier}`);
  return next(specifier, context);
}

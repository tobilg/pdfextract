# @pdfextract/storage

Storage adapters for core's engine-neutral `StorageAdapter`. ESM, Node ≥22.12.0 and
browsers (S3 only). Import the adapter subpath; the root exports shared types.

## Installation

```sh
pnpm add @pdfextract/core @pdfextract/storage
# Add the AWS client only when using S3:
pnpm add @aws-sdk/client-s3
```

Before the first npm release, install the local core and storage `.tgz` files produced
by `pnpm pack` in the repository. The filesystem adapter requires Node; keep its imports
out of browser code.

## Usage

Both adapters implement the same interface. This helper accepts an adapter and exact
bytes, writes them with metadata, and reads them back through a web stream:

```ts
import type { StorageAdapter } from '@pdfextract/storage';

export async function storeAndRead(storage: StorageAdapter, bytes: Uint8Array) {
  await storage.put('source.pdf', bytes, {
    contentType: 'application/pdf',
    metadata: { source: 'upload' },
    contentLength: bytes.byteLength,
  });
  const info = await storage.head('source.pdf');
  const object = await storage.get('source.pdf');
  const restored = new Uint8Array(await new Response(object.body).arrayBuffer());
  return { info, bytes: restored };
}
```

Call `storage.delete('source.pdf')` to remove an object; deletion is idempotent.
`put` also accepts `ReadableStream<Uint8Array>` and supports `signal` and `onProgress`.
Use a fresh extraction prefix for each manifest and its assets; see the
[persistence guide](../documentation/guides/storage.md) for the complete workflow.

Keys are portable relative ASCII paths, at most 1024 characters (including configured
S3 prefix). Every segment starts with a letter, digit or underscore and then contains
letters/digits/underscore/dot/hyphen. Absolute paths, empty segments, traversal and
backslashes are rejected consistently. Metadata keys are lowercase ASCII (64 chars
max); values printable ASCII; total key/value bytes ≤2048. Content type is preserved.
Consume or cancel every returned body stream. Missing objects have `STORAGE_NOT_FOUND`;
permission/network failures remain distinct. Supplied content lengths are checked.

## Filesystem

Create a private directory and resolve its canonical path before creating the adapter:

```ts
import { mkdir, realpath } from 'node:fs/promises';
import { createFilesystemStorage } from '@pdfextract/storage/filesystem';

await mkdir('./pdf-assets', { recursive: true, mode: 0o700 });
const storage = createFilesystemStorage({ directory: await realpath('./pdf-assets') });
```

Node-only. SHA-256 maps each logical key into a flat private root directory. A single
record stores JSON metadata plus body. Writes stream into an exclusive temporary file,
sync it, and atomically rename it over the prior record. Readers keep an open descriptor
to one generation; failed pre-publication writes preserve the old body/metadata pair.
Metadata survives adapter/process restarts. Delete and replacement operate on the record
itself; symlinks are not followed. Root paths resolving through symlinks are rejected:
use `await realpath(directory)` for platform aliases such as macOS `/tmp`.

Tested on macOS and Linux (Node 22.12.0 in a Debian Bookworm container).
File fsync is used; directory fsync is not,
so atomic visibility is not a promise of surviving every power loss. Network filesystems
and Windows replacement semantics are unverified. Use a private root with trusted,
stable ancestors: Node's portable pathname APIs cannot guarantee confinement against a
privileged concurrent attacker replacing ancestor directories between checks. No
cross-process writer lock is provided; successful concurrent writes are last-renamer-wins.

## S3

Pass a configured, authorized client from the host application. Configure endpoint,
region and credentials on that client; this factory works in both browsers and Node:

```ts
import type { S3Client } from '@aws-sdk/client-s3';
import { createS3Storage } from '@pdfextract/storage/s3';

export function storageFor(client: S3Client) {
  return createS3Storage({
    client,
    bucket: 'pdf-assets',
    prefix: 'extractions/',
    multipart: { mode: 'always', partSize: 8 * 1024 * 1024, concurrency: 3 },
  });
}
```

Uses the **caller's** AWS SDK v3 `S3Client` optional peer, configured for AWS or a compatible
endpoint. Never destroys it. No SDK implementation types appear in shared core contracts.
Every put uses explicit CreateMultipartUpload/UploadPart/CompleteMultipartUpload commands,
including small nonempty objects. No PutObject fallback. Empty uploads attempt one empty
part; a rejecting backend reports `STORAGE_CAPABILITY_UNSUPPORTED` (or an uncertain
completion if its completion response is ambiguous). Validate this against your service.

Parts are owned/replayable, 5 MiB–5 GiB, at most 10,000, concurrency 1–32. Default memory
is approximately three 8 MiB parts plus source read-ahead. A caller-provided giant stream
chunk is outside the adapter's read-ahead budget. SDK retries replay buffered bytes;
progress counts a part only after success. Checksums negotiated by the SDK/backend are
included in ordered completion. The default local S3rver test uses checksums WHEN_REQUIRED;
additional deterministic tests cover explicit checksum negotiation. Configure production
checksum policy on the host client according to its endpoint's support.

Failure cancels/settles in-flight requests and attempts AbortMultipartUpload using a
fresh 10-second signal; `cleanupErrors` preserves abort errors alongside the primary cause.
The old key is never deleted before completion. Once completion was attempted, a lost
response can mean the new object exists: `COMMIT_OUTCOME_UNKNOWN` requires reconciliation
using your manifest/digest/version policy. There is no speculative DeleteObject rollback.
An MPU creation response lost after server success can leave an unknown upload ID;
configure the host bucket's incomplete-MPU lifecycle cleanup as an operational backstop.

Browser clients/configuration must be host-authorized. Allow GET/HEAD/PUT/POST/DELETE and
the requested x-amz headers in bucket CORS; expose ETag, version and checksum headers.
Never embed permanent credentials. See the runnable browser example and CORS test fixture.
No auth server, cloud resources or production bucket changes are supplied.

## License

License decision pending: UNLICENSED local prerelease; AWS/Smithy licenses are Apache-2.0.

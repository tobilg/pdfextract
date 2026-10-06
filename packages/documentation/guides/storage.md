---
title: Storage and persistence
group: Guides
---

# Storage and persistence

{@link "@pdfextract/core".StorageAdapter} defines `put`, `get`, `head` and idempotent
`delete`. Adapters accept bytes/web streams and return a web stream from `get`.
Consume or cancel returned bodies. Content type and portable metadata survive storage;
`STORAGE_NOT_FOUND` stays distinct from permission and network errors.

Keys are relative ASCII paths up to 1024 characters, including an S3 prefix. Segments
start with a letter, digit or underscore, followed by letters/digits/underscore/dot/hyphen.
Traversal, absolute paths, empty segments and backslashes are rejected. Metadata uses
lowercase ASCII keys (up to 64 characters), printable ASCII values, and a 2048-byte total.

{@includeCode ../examples/storage.ts}

The S3 example works in browsers and Node. The application must
validate its persisted manifest before choosing a key; the complete example also checks
the stored full-size image's SHA-256 before invoking its callback.

## Filesystem

{@includeCode ../examples/filesystem.ts}

The Node-only adapter uses a private canonical root and a flat hashed filename per key.
One record holds metadata and body. Streamed writes go to an exclusive temporary file,
which is fsynced and renamed only after success. Readers retain one coherent generation;
a failed pre-publication write preserves the old body/metadata pair.

Root symlink aliases are rejected. Use `realpath` for aliases such as macOS `/tmp` and
trusted, stable ancestors. Portable Node pathname APIs cannot defend against a privileged
attacker swapping ancestor directories concurrently. File fsync is used, directory fsync
is not: power-loss durability, Windows replacement and network filesystems are unverified.
MacOS and Linux replacement/stream/symlink checks pass. Concurrent successful writes are
last-renamer-wins.

## Strict multipart S3

The adapter borrows the host's AWS SDK v3 `S3Client`. Configure authorized credentials,
region and compatible endpoint on that client; the adapter never destroys it. Every write
uses explicit multipart commands, including small bodies. Empty bodies attempt an empty
part and report an unsupported backend or uncertain completion; there is no single-PUT fallback.

Defaults are 8 MiB parts and three concurrent requests. Parts are replayable; retries
do not inflate progress. Known content lengths are checked, completion is ordered and
negotiated checksums are forwarded. Limits are 5 MiB–5 GiB per part and 10,000 parts.

Failure settles/cancels active work before a fresh-signal abort request. Cleanup errors
remain attached to the primary error. Replacement never deletes the old object first.
Once completion is attempted, a lost response can mean the new object already exists:
`COMMIT_OUTCOME_UNKNOWN` needs reconciliation, not speculative deletion. Configure incomplete
multipart lifecycle cleanup for uploads whose creation response was lost.

Browser S3 must use host-authorized configuration, normally temporary credentials.
Allow the required GET/HEAD/PUT/POST/DELETE requests and x-amz headers in bucket CORS;
expose ETag/version/checksum headers. No auth server or permanent browser credentials are provided.
The default integration backend is MIT-licensed S3rver; production endpoint checks are opt-in.

## Manifest-last workflow

The [shared runnable workflow](https://github.com/tobilg/pdfextract/blob/main/examples/shared/persistence.ts)
uses a fresh UUID prefix, optionally stores the source, then stores text JSON/plain text,
each full PNG and a separate thumbnail. It validates and publishes a manifest only after
every referenced asset succeeds. Failure cleans up owned keys or reports orphans and uncertain
commits. Manifest-last is not a transaction for overwriting an existing extraction.

Fresh sessions read the manifest and thumbnails directly from storage. Selection retrieves
the original stored full-size bytes, verifies their digest, wraps them in a `File` and
calls the host. It does not reopen the PDF or re-encode the selected image. Browser gallery
cleanup revokes object URLs; Ctrl-C cancels the Node workflow.

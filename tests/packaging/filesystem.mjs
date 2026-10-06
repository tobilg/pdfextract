import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFilesystemStorage } from '@pdfextract/storage/filesystem';

test('FS-01/02 STORE-01/02: coherent replacement readers, streamed failure, restart and symlink isolation', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'pdfextract-fs-'));
  const store = createFilesystemStorage({ directory });
  const bytes = async (object) => new Uint8Array(await new Response(object.body).arrayBuffer());
  try {
    const old = new Uint8Array(100000).fill(23),
      fresh = new Uint8Array(200000).fill(147);
    await store.put('key', old, { metadata: { revision: 'old' }, contentType: 'image/png' });
    const reader = await store.get('key');
    await store.put('key', fresh, { metadata: { revision: 'new' }, contentType: 'image/jpeg' });
    assert.equal(reader.metadata.revision, 'old');
    assert.ok(Buffer.from(await bytes(reader)).equals(Buffer.from(old)));
    const next = await createFilesystemStorage({ directory }).get('key');
    assert.equal(next.metadata.revision, 'new');
    assert.equal(next.contentType, 'image/jpeg');
    assert.ok(Buffer.from(await bytes(next)).equals(Buffer.from(fresh)));
    let pulls = 0;
    await assert.rejects(
      store.put(
        'key',
        new ReadableStream({
          pull(c) {
            if (++pulls < 3) c.enqueue(old);
            else c.error(new Error('midstream'));
          },
        }),
      ),
      { code: 'STORAGE_IO_ERROR' },
    );
    assert.ok(Buffer.from(await bytes(await store.get('key'))).equals(Buffer.from(fresh)));
    const cancelled = new AbortController();
    await assert.rejects(
      store.put('key', old, {
        signal: cancelled.signal,
        onProgress() {
          cancelled.abort();
        },
      }),
      { code: 'ABORTED' },
    );
    assert.equal((await store.head('key')).metadata.revision, 'new');
    assert.deepEqual(
      (await readdir(directory)).filter((n) => n.startsWith('.write-')),
      [],
    );
    for (const key of ['../escape', '/absolute', 'a\\b', 'a//b'])
      await assert.rejects(store.put(key, old), { code: 'INVALID_STORAGE_KEY' });
    const file = join(directory, `${createHash('sha256').update('key').digest('hex')}.object`);
    await rm(file);
    await symlink('/etc/passwd', file);
    await assert.rejects(store.get('key'));
    await store.put('key', old); // Rename replaces the link itself; never follows it.
    assert.ok(Buffer.from(await bytes(await store.get('key'))).equals(Buffer.from(old)));
    await store.delete('key');
    await store.delete('key');
    await assert.rejects(store.get('key'), { code: 'STORAGE_NOT_FOUND' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

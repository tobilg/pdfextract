import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { createS3Storage } from '@pdfextract/storage/s3';

const bucket = process.env.PDFEXTRACT_TEST_BUCKET;
if (!bucket)
  throw new Error(
    'Not executed: set PDFEXTRACT_TEST_BUCKET to an explicitly authorized disposable test bucket and configure AWS credentials.',
  );
const client = new S3Client({
  region: process.env.AWS_REGION ?? 'us-east-1',
  endpoint: process.env.PDFEXTRACT_TEST_ENDPOINT,
  forcePathStyle: !!process.env.PDFEXTRACT_TEST_ENDPOINT,
});
const prefix = `pdfextract-test-${randomUUID()}/`;
const storage = createS3Storage({ client, bucket, prefix });
const created = [];
try {
  for (const size of [0, 1, 8 * 1024 * 1024, 8 * 1024 * 1024 + 1]) {
    const bytes = new Uint8Array(size).fill(79),
      key = `${size}.bin`;
    created.push(key);
    await storage.put(key, new Blob([bytes]).stream(), {
      contentLength: size,
      contentType: 'application/octet-stream',
      metadata: { fixture: 'pdfextract' },
    });
    const result = await storage.get(key);
    assert.equal(result.metadata.fixture, 'pdfextract');
    assert.ok(
      Buffer.from(await new Response(result.body).arrayBuffer()).equals(Buffer.from(bytes)),
    );
  }
  console.log(`Real endpoint strict multipart checks passed in ${prefix}`);
} finally {
  const cleanup = await Promise.allSettled(created.map((key) => storage.delete(key)));
  client.destroy();
  cleanup.forEach((result, i) => {
    if (result.status === 'rejected')
      console.error('Cleanup required:', prefix + created[i], result.reason);
  });
}

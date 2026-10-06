import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export async function temporaryDirectory(prefix: string) {
  return mkdtemp(join(await realpath(tmpdir()), prefix));
}

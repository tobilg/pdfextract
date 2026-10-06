import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PUBLIC_PACKAGES } from './packages.mjs';

const docker = spawnSync('docker', ['info'], { encoding: 'utf8' });
if (docker.status !== 0) {
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/linux-consumer.log', (docker.stdout ?? '') + (docker.stderr ?? ''));
  throw new Error(
    'Linux check not executed: Docker daemon unavailable. Restore Docker and ensure sufficient free disk, then rerun pnpm test:linux.',
  );
}
const dir = await mkdtemp(join(tmpdir(), 'pdfextract-linux-input-'));
// The test uses a public image. Avoid a host credential helper/keychain prompt while
// keeping the selected daemon and the user's persistent Docker configuration intact.
const endpoint =
  process.env.DOCKER_HOST ||
  spawnSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], {
    encoding: 'utf8',
  }).stdout?.trim();
if (!endpoint) throw new Error('Cannot determine the active Docker daemon endpoint');
const dockerConfig = join(dir, 'docker-config');
await mkdir(dockerConfig);
await writeFile(join(dockerConfig, 'config.json'), '{"auths":{}}\n');
for (const name of PUBLIC_PACKAGES) {
  const { version } = JSON.parse(await readFile(`packages/${name}/package.json`, 'utf8'));
  await cp(`artifacts/pdfextract-${name}-${version}.tgz`, join(dir, `${name}.tgz`));
}
for (const name of ['smoke.mjs', 'filesystem.mjs', 'isolation-loader.mjs'])
  await cp(`tests/packaging/${name}`, join(dir, name));
for (const name of ['baseline', 'scan'])
  await cp(`tests/fixtures/${name}.pdf`, join(dir, `${name}.pdf`));
await mkdir(join(dir, 'languages'));
await cp(
  'node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz',
  join(dir, 'languages/eng.traineddata.gz'),
);
await writeFile(
  join(dir, 'package.json'),
  JSON.stringify({
    type: 'module',
    dependencies: {
      '@pdfextract/core': 'file:core.tgz',
      '@pdfextract/ocr': 'file:ocr.tgz',
      '@pdfextract/storage': 'file:storage.tgz',
      '@aws-sdk/client-s3': '3.1146.0',
    },
  }),
);
const command =
  'cp -R /input/. /tmp/consumer/ && cd /tmp/consumer && npm install --ignore-scripts --no-audit --no-fund && node smoke.mjs && node --test filesystem.mjs && node --loader ./isolation-loader.mjs --input-type=module -e "await import(\'@pdfextract/storage/filesystem\')"';
const child = spawn(
  'docker',
  [
    '--config',
    dockerConfig,
    '--host',
    endpoint,
    'run',
    '--rm',
    '--mount',
    `type=bind,source=${resolve(dir)},target=/input,readonly`,
    'node:22.12.0-bookworm-slim',
    'sh',
    '-c',
    `mkdir /tmp/consumer && ${command}`,
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let output = '';
for (const [stream, destination] of [
  [child.stdout, process.stdout],
  [child.stderr, process.stderr],
]) {
  stream.on('data', (chunk) => {
    destination.write(chunk);
    output += chunk.toString();
  });
}
const status = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', resolve);
});
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/linux-consumer.log', output);
if (status !== 0) throw new Error(`Linux consumer failed: ${status}; input retained at ${dir}`);
console.log(`Linux Node 22.12.0 and filesystem checks passed; input ${dir}`);

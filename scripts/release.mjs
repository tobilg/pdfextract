import { appendFile, readFile } from 'node:fs/promises';
import { PUBLIC_PACKAGES } from './packages.mjs';

const manifests = await Promise.all(
  PUBLIC_PACKAGES.map(async (name) =>
    JSON.parse(await readFile(`packages/${name}/package.json`, 'utf8')),
  ),
);
for (const name of ['documentation', 'demo']) {
  const manifest = JSON.parse(await readFile(`packages/${name}/package.json`, 'utf8'));
  if (manifest.private !== true) throw new Error(`The ${name} workspace must be private`);
}
const version = manifests[0].version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version))
  throw new Error('Release version must be a simple semver without build metadata');
for (const [index, manifest] of manifests.entries()) {
  if (manifest.name !== `@pdfextract/${PUBLIC_PACKAGES[index]}` || manifest.private)
    throw new Error('Unexpected public package identity');
  if (manifest.version !== version) throw new Error('All three library versions must match');
  if (manifest.repository?.url !== 'git+https://github.com/tobilg/pdfextract.git')
    throw new Error('Package repository must match the npm trusted-publisher repository');
}
const dryRun = process.env.RELEASE_DRY_RUN === 'true';
if (process.env.GITHUB_REF_TYPE === 'tag') {
  if (!/^v\d+\.\d+\.\d+$/.test(process.env.GITHUB_REF_NAME ?? ''))
    throw new Error('Release tags must have the form vX.X.X without a prerelease or suffix');
  if (process.env.GITHUB_REF_NAME !== `v${version}`)
    throw new Error(`Release tag must match v${version}`);
} else if (!dryRun) {
  throw new Error(
    'A real release requires a matching vX.X.X tag; use RELEASE_DRY_RUN=true locally',
  );
}
if (!dryRun && manifests.some((m) => !m.license || m.license === 'UNLICENSED'))
  throw new Error(
    'Owner package license is unresolved. Set the approved license before publishing.',
  );
const prerelease = version.includes('-');
const identifier = version.split('-').slice(1).join('-').split('.')[0];
const tag = prerelease ? (/^[a-zA-Z][\w-]*$/.test(identifier) ? identifier : 'next') : 'latest';
const result = {
  version,
  npm_tag: tag,
  prerelease: String(prerelease),
  dry_run: String(dryRun),
  packages: PUBLIC_PACKAGES.join(' '),
};
if (process.env.GITHUB_OUTPUT)
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `${Object.entries(result)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`,
  );
console.log(JSON.stringify(result, null, 2));

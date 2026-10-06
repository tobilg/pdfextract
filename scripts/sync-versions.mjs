import { readFile, writeFile } from 'node:fs/promises';
import { PUBLIC_PACKAGES } from './packages.mjs';

const usage = 'Usage: pnpm version:sync [X.Y.Z] [--check | --dry-run]';
const args = process.argv.slice(2);
const flags = args.filter((arg) => arg.startsWith('--'));
const versions = args.filter((arg) => !arg.startsWith('--'));
if (
  versions.length > 1 ||
  flags.some((flag) => !['--check', '--dry-run'].includes(flag)) ||
  flags.length > 1
)
  throw new Error(usage);

// The private websites share release metadata, but remain outside the npm allowlist.
const packages = await Promise.all(
  [...PUBLIC_PACKAGES, 'documentation', 'demo'].map(async (name) => {
    const file = `packages/${name}/package.json`;
    const original = await readFile(file, 'utf8');
    const manifest = JSON.parse(original);
    if (manifest.name !== `@pdfextract/${name}`)
      throw new Error(`Unexpected package identity in ${file}`);
    return { file, original, manifest };
  }),
);
const version = versions[0] ?? packages[0].manifest.version;
if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
  throw new Error(`Expected a stable X.Y.Z version without a v prefix or suffix. ${usage}`);

const names = new Set(packages.map(({ manifest }) => manifest.name));
const changes = [];
for (const { file, manifest } of packages) {
  if (manifest.version !== version) {
    changes.push(`${file}: version ${manifest.version} → ${version}`);
    manifest.version = version;
  }
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (names.has(name) && range !== `^${version}`) {
      changes.push(`${file}: peer ${name} ${range} → ^${version}`);
      manifest.peerDependencies[name] = `^${version}`;
    }
  }
}

if (!changes.length) {
  console.log(`All ${packages.length} package versions and internal peers match ${version}.`);
} else if (flags.includes('--check')) {
  console.error(`Package versions are not synchronized:\n${changes.join('\n')}`);
  console.error(`Run pnpm version:sync ${version}`);
  process.exitCode = 1;
} else {
  console.log(changes.join('\n'));
  if (!flags.includes('--dry-run')) {
    // Parse and validate every manifest before writing any of them. Leave untouched
    // files byte-identical and preserve existing workspace links/external dependencies.
    for (const { file, original, manifest } of packages) {
      const next = `${JSON.stringify(manifest, null, 2)}\n`;
      if (JSON.stringify(JSON.parse(original)) !== JSON.stringify(manifest))
        await writeFile(file, next);
    }
    console.log(
      `Synchronized ${packages.length} packages to ${version}. No commit or tag created.`,
    );
  }
}

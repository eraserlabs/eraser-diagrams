import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function publicPackages(root) {
  return readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const directory = join(root, 'packages', entry.name);
      const path = join(directory, 'package.json');
      return {
        directory,
        path,
        manifest: JSON.parse(readFileSync(path, 'utf8')),
      };
    })
    .filter(({ manifest }) => !manifest.private);
}

export function releaseVersion(packages) {
  const versions = new Set(packages.map(({ manifest }) => manifest.version));
  const [version] = versions;
  if (versions.size !== 1 || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('All public packages must have the same stable version.');
  }
  return version;
}

export function bump(packages, kind) {
  const index = ['major', 'minor', 'patch'].indexOf(kind);
  if (index < 0) {
    throw new Error('Choose major, minor, or patch.');
  }
  const parts = releaseVersion(packages).split('.').map(Number);
  parts[index] += 1;
  parts.fill(0, index + 1);
  const version = parts.join('.');
  for (const { path, manifest } of packages) {
    writeFileSync(
      path,
      `${JSON.stringify({ ...manifest, version }, null, 2)}\n`,
    );
  }
  return version;
}

export function publicationOrder(packages) {
  const pending = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));
  const ordered = [];
  while (pending.size) {
    const next = [...pending.values()].find(({ manifest }) =>
      Object.keys({
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
      }).every((name) => !pending.has(name)),
    );
    if (!next) {
      throw new Error('Public packages have a circular dependency.');
    }
    ordered.push(next);
    pending.delete(next.manifest.name);
  }
  return ordered;
}

export async function unpublishedPackages(packages, fetchVersion = fetch) {
  const version = releaseVersion(packages);
  const unpublished = [];
  // Check every package before publishing anything. Only a 404 means unpublished.
  for (const pkg of publicationOrder(packages)) {
    const response = await fetchVersion(
      `https://registry.npmjs.org/${encodeURIComponent(pkg.manifest.name)}/${version}`,
      { signal: AbortSignal.timeout(30_000) },
    );
    if (response.status === 404) {
      unpublished.push(pkg);
    } else if (!response.ok) {
      throw new Error(
        `npm lookup failed for ${pkg.manifest.name}: HTTP ${response.status}`,
      );
    }
  }
  return unpublished;
}

async function publish(packages) {
  const unpublished = await unpublishedPackages(packages);
  const temporary = mkdtempSync(join(tmpdir(), 'eraser-release-'));
  const run = (command, args, cwd) =>
    execFileSync(command, args, { cwd, stdio: 'inherit' });
  try {
    // pnpm pack replaces workspace:* with exact versions. npm handles OIDC auth.
    const archives = unpublished.map((pkg, index) => {
      const archive = join(temporary, `${index}.tgz`);
      run('pnpm', ['pack', '--out', archive], pkg.directory);
      return archive;
    });
    for (const archive of archives) {
      run('npm', [
        'publish',
        archive,
        '--access',
        'public',
        '--registry',
        'https://registry.npmjs.org',
      ]);
    }
    process.stdout.write(
      `Published ${archives.length} packages; skipped ${packages.length - archives.length} existing versions.\n`,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const packages = publicPackages(resolve(import.meta.dirname, '..'));
  switch (process.argv[2]) {
    case 'bump':
      process.stdout.write(`${bump(packages, process.argv[3])}\n`);
      break;
    case 'check':
      process.stdout.write(`${releaseVersion(packages)}\n`);
      break;
    case 'publish':
      await publish(packages);
      break;
    default:
      throw new Error(
        'Usage: node tools/release.mjs check | bump <patch|minor|major> | publish',
      );
  }
}

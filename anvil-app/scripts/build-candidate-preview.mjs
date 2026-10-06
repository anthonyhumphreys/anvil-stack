#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { previewBuilderConfig } from './preview-builder-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const [pr, headSha, requestedArch, requestedPlatform] = args;
const nativePlatform =
  process.platform === 'darwin' || process.platform === 'linux' ? process.platform : null;
const platform = requestedPlatform ?? nativePlatform;
const arch = requestedArch ?? (platform === 'darwin' ? 'arm64' : 'x64');
if (
  args.length < 2 ||
  args.length > 4 ||
  !/^[1-9]\d*$/.test(pr ?? '') ||
  !Number.isSafeInteger(Number(pr)) ||
  !/^[a-f0-9]{40}$/.test(headSha ?? '') ||
  !['arm64', 'x64'].includes(arch) ||
  !['darwin', 'linux'].includes(platform)
) {
  throw new Error(
    'Usage: node scripts/build-candidate-preview.mjs <PR number> <full head SHA> [arm64|x64] [darwin|linux]',
  );
}
if (!nativePlatform)
  throw new Error('Candidate previews require a native macOS or Linux build host.');
if (platform !== nativePlatform)
  throw new Error('Candidate preview target must match the native build host.');
if (platform === 'linux' && (process.arch !== 'x64' || arch !== 'x64')) {
  throw new Error('Linux candidate previews support native x64 builds only.');
}
const buildId = `pr-${pr}-${headSha}-${platform}-${arch}-${randomUUID().replaceAll('-', '')}`;
const output = path.join(root, 'dist', 'previews', buildId);
mkdirSync(output, { recursive: true });
const configPath = path.join(output, '.preview-builder.json');
const identity = { buildId, pullRequestNumber: Number(pr), headSha, platform, arch };
const productName = `Anvil Preview PR ${pr} ${headSha.slice(0, 8)}`;
const linuxPackageName = `anvil-preview-pr${pr}-h${headSha.slice(0, 8)}`;
const expectedExtensions = platform === 'darwin' ? ['dmg', 'zip'] : ['appimage', 'deb', 'pacman'];
const manifest = {
  ...identity,
  createdAt: new Date().toISOString(),
  status: 'failed',
  signing: platform === 'darwin' ? 'unavailable' : 'unsigned',
  manualChecks: 'not-run',
  artifacts: [],
  limitations: [
    ...(platform === 'darwin'
      ? ['Unsigned internal preview. Gatekeeper acceptance is not verified.']
      : ['Linux packages are unsigned; package installation and launch are not verified.']),
    'Application data is isolated; added repositories and external tools still access real files and services.',
  ],
};
const env = {
  ...process.env,
  ANVIL_DEPLOYMENT_ENV: 'staging',
  ANVIL_PREVIEW_BUILD: JSON.stringify(identity),
  ANVIL_UPDATE_ORIGIN: '',
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
};
function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} failed: ${result.error?.message ?? result.stderr ?? result.status}`,
    );
  return result.stdout?.trim();
}
try {
  if (run('git', ['rev-parse', 'HEAD'], true) !== headSha)
    throw new Error('Checkout does not match candidate head SHA.');
  if (run('git', ['status', '--porcelain', '--untracked-files=normal'], true)) {
    throw new Error('Candidate preview requires a clean checkout. Commit changes before building.');
  }
  writeFileSync(
    configPath,
    JSON.stringify(
      previewBuilderConfig(parse(readFileSync(path.join(root, 'electron-builder.yml'), 'utf8')), {
        platform,
        ...(platform === 'linux'
          ? { productName, executableName: linuxPackageName, packageName: linuxPackageName }
          : {}),
      }),
    ),
  );
  const platformArgs =
    platform === 'darwin'
      ? ['--mac', 'dmg', 'zip', `--${arch}`]
      : ['--linux', 'AppImage', 'deb', 'pacman', '--x64'];
  run(process.execPath, [
    'scripts/dist.mjs',
    '--brand=anvil',
    '--config',
    configPath,
    ...platformArgs,
    '--publish',
    'never',
    `-c.productName=${productName}`,
    `-c.appId=dev.anthonyhumphreys.anvil.preview.pr${pr}.h${headSha}`,
    `-c.directories.output=${output}`,
    ...(platform === 'darwin' ? ['-c.mac.identity=null'] : []),
  ]);
  const extension = (file) => path.extname(file).slice(1).toLowerCase();
  manifest.artifacts = readdirSync(output)
    .filter((file) => expectedExtensions.includes(extension(file)))
    .map((file) => ({
      file,
      sha256: createHash('sha256')
        .update(readFileSync(path.join(output, file)))
        .digest('hex'),
    }));
  if (
    manifest.artifacts.length !== expectedExtensions.length ||
    expectedExtensions.some(
      (expected) => !manifest.artifacts.some((artifact) => extension(artifact.file) === expected),
    )
  ) {
    throw new Error(`Expected preview artifacts: ${expectedExtensions.join(', ')}.`);
  }
  manifest.status = 'built';
} catch (error) {
  manifest.failure = error instanceof Error ? error.message : String(error);
  console.error(manifest.failure);
  process.exitCode = 1;
} finally {
  rmSync(configPath, { force: true });
  writeFileSync(
    path.join(output, 'preview-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  console.log(`Preview evidence: ${path.join(output, 'preview-manifest.json')}`);
}

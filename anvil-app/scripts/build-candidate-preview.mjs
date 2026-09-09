#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { previewBuilderConfig } from './preview-builder-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [pr, headSha, arch = 'arm64'] = process.argv.slice(2);
if (
  !/^[1-9]\d*$/.test(pr ?? '') ||
  !Number.isSafeInteger(Number(pr)) ||
  !/^[a-f0-9]{40}$/.test(headSha ?? '') ||
  !['arm64', 'x64'].includes(arch)
) {
  throw new Error(
    'Usage: node scripts/build-candidate-preview.mjs <PR number> <full head SHA> [arm64|x64]',
  );
}
const buildId = `pr-${pr}-${headSha}-darwin-${arch}-${randomUUID().replaceAll('-', '')}`;
const output = path.join(root, 'dist', 'previews', buildId);
mkdirSync(output, { recursive: true });
const configPath = path.join(output, '.preview-builder.json');
const identity = { buildId, pullRequestNumber: Number(pr), headSha, platform: 'darwin', arch };
const manifest = {
  ...identity,
  createdAt: new Date().toISOString(),
  status: 'failed',
  signing: 'unavailable',
  manualChecks: 'not-run',
  artifacts: [],
  limitations: [
    'Unsigned internal preview. Gatekeeper acceptance is not verified.',
    'Application data is isolated; added repositories and external tools still access real files and services.',
  ],
};
const env = {
  ...process.env,
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
  if (process.platform !== 'darwin') throw new Error('Native macOS preview builds require macOS.');
  if (run('git', ['rev-parse', 'HEAD'], true) !== headSha)
    throw new Error('Checkout does not match candidate head SHA.');
  if (run('git', ['status', '--porcelain', '--untracked-files=normal'], true)) {
    throw new Error('Candidate preview requires a clean checkout. Commit changes before building.');
  }
  writeFileSync(
    configPath,
    JSON.stringify(
      previewBuilderConfig(parse(readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'))),
    ),
  );
  run(process.execPath, [
    'scripts/dist.mjs',
    '--brand=anvil',
    '--config',
    configPath,
    '--mac',
    'dmg',
    'zip',
    `--${arch}`,
    '--publish',
    'never',
    `-c.productName=Anvil Preview PR ${pr} ${headSha.slice(0, 8)}`,
    `-c.appId=dev.anthonyhumphreys.anvil.preview.pr${pr}.h${headSha}`,
    `-c.directories.output=${output}`,
    '-c.mac.identity=null',
  ]);
  manifest.artifacts = readdirSync(output)
    .filter((file) => /\.(dmg|zip)$/.test(file))
    .map((file) => ({
      file,
      sha256: createHash('sha256')
        .update(readFileSync(path.join(output, file)))
        .digest('hex'),
    }));
  if (manifest.artifacts.length !== 2) throw new Error('Expected both DMG and ZIP artifacts.');
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

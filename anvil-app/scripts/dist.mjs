#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const brands = {
  anvil: {
    productName: 'Anvil',
    appId: 'dev.anthonyhumphreys.anvil',
    copyright: 'AnthonyHumphreys.dev',
    macIcon: 'resources/anvil.icns',
    pngIcon: 'resources/anvil.png',
  },
};

const args = process.argv.slice(2);
let brandId =
  process.env.ANVIL_BRAND || process.env.npm_config_brand || process.env.ANVIL_BUILD_BRAND || '';
const builderArgs = [];

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--') continue;
  if (arg === '--brand') {
    brandId = args[index + 1] ?? '';
    index += 1;
    continue;
  }
  if (arg.startsWith('--brand=')) {
    brandId = arg.slice('--brand='.length);
    continue;
  }
  builderArgs.push(arg);
}

if (!brandId) brandId = 'anvil';
if (!Object.hasOwn(brands, brandId)) {
  console.error(
    `[dist] Unknown brand "${brandId}". Expected one of: ${Object.keys(brands).join(', ')}`,
  );
  process.exit(1);
}

if (builderArgs.length === 0) {
  builderArgs.push('--mac', 'dmg', 'zip', '--arm64', '--publish', 'never');
}

const brand = brands[brandId];
const env = { ...process.env, ANVIL_BRAND: brandId, ANVIL_BUILD_BRAND: brandId };

function commandExists(command) {
  const result = spawnSync(command, ['--version'], { cwd: repoRoot, env, stdio: 'ignore' });
  return !result.error && result.status === 0;
}

function resolvePackageManager() {
  if (process.env.ANVIL_PACKAGE_MANAGER) return process.env.ANVIL_PACKAGE_MANAGER;

  const npmExecPath = process.env.npm_execpath ?? '';
  const userAgent = process.env.npm_config_user_agent ?? '';

  if (npmExecPath.includes('pnpm') || userAgent.startsWith('pnpm')) return 'pnpm';
  if (npmExecPath.includes('yarn') || userAgent.startsWith('yarn')) return 'yarn';
  if (existsSync(path.join(repoRoot, 'pnpm-lock.yaml')) && commandExists('pnpm')) return 'pnpm';

  return 'npm';
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
    ...options,
  });

  if (result.error) {
    console.error(`[dist] Failed to run ${command}:`, result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`[dist] Building ${brand.productName} (${brandId})`);
run(resolvePackageManager(), ['run', 'build']);
run(process.execPath, [
  path.join(repoRoot, 'node_modules/electron-builder/cli.js'),
  `-c.productName=${brand.productName}`,
  `-c.appId=${brand.appId}`,
  `-c.copyright=${brand.copyright}`,
  ...(brand.macIcon ? [`-c.mac.icon=${brand.macIcon}`] : []),
  ...(brand.pngIcon ? [`-c.win.icon=${brand.pngIcon}`, `-c.linux.icon=${brand.pngIcon}`] : []),
  ...builderArgs,
]);

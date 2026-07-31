import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = join(projectRoot, 'resources', 'apple-speech-recognition-helper.swift');
const infoPlistPath = join(projectRoot, 'resources', 'apple-speech-recognition-helper-Info.plist');
const entitlementsPath = join(projectRoot, 'resources', 'entitlements.mac.plist');
const helperName = 'apple-speech-recognition-helper';
const helperAppName = 'Anvil Speech Recognition.app';

async function compileHelper(outputAppPath) {
  const contentsPath = join(outputAppPath, 'Contents');
  const executablePath = join(contentsPath, 'MacOS', helperName);
  await mkdir(dirname(executablePath), { recursive: true });
  await copyFile(infoPlistPath, join(contentsPath, 'Info.plist'));
  await execFileAsync('/usr/bin/xcrun', ['swiftc', sourcePath, '-o', executablePath], {
    maxBuffer: 2 * 1024 * 1024,
  });
  await chmod(executablePath, 0o755);
  await execFileAsync('/usr/bin/codesign', [
    '--force',
    '--deep',
    '--sign',
    '-',
    '--entitlements',
    entitlementsPath,
    outputAppPath,
  ]);
}

export default async function buildAppleSpeechHelper(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const outputAppPath = join(context.appOutDir, appName, 'Contents', 'Resources', helperAppName);
  await compileHelper(outputAppPath);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'darwin') process.exit(0);

  const outputAppPath = process.argv[2]
    ? resolve(process.argv[2])
    : join(projectRoot, 'resources', '.build', helperAppName);
  await compileHelper(outputAppPath);
  console.log(`Built ${basename(outputAppPath)}`);
}

import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import {
  APP_NAME,
  LEGACY_HIDDEN_DIR_NAME,
  PRIMARY_HIDDEN_DIR_NAME,
} from '../../shared/app-identity.js';

export function getPrimaryUserDataPath(): string {
  return path.join(app.getPath('appData'), APP_NAME);
}

/** Select one profile without copying or adopting another identity's data. */
export function configureUserDataPath(
  options: { previewDirectory?: string; developmentPath?: string } = {},
): void {
  if (options.previewDirectory) {
    const previewPath = path.join(app.getPath('appData'), options.previewDirectory);
    mkdirSync(previewPath, { recursive: true });
    app.setPath('userData', previewPath);
    app.setPath('sessionData', previewPath);
    return;
  }
  const developmentPath = options.developmentPath?.trim();
  if (developmentPath) {
    app.setPath('userData', path.resolve(developmentPath));
    return;
  }
  app.setPath('userData', getPrimaryUserDataPath());
}

export function getPrimaryHiddenDirPath(): string {
  return path.join(homedir(), PRIMARY_HIDDEN_DIR_NAME);
}

export function getLegacyHiddenDirPath(): string {
  return path.join(homedir(), LEGACY_HIDDEN_DIR_NAME);
}

export function getHiddenDirCandidates(): string[] {
  return [getPrimaryHiddenDirPath(), getLegacyHiddenDirPath()];
}

export function resolveExistingHiddenDirPath(): string {
  return (
    getHiddenDirCandidates().find((candidate) => existsSync(candidate)) ?? getPrimaryHiddenDirPath()
  );
}

import { existsSync } from 'node:fs';
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

export function getLegacyUserDataPaths(): string[] {
  return ['devhub', 'DevHub'].map((name) => path.join(app.getPath('appData'), name));
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

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const profile = vi.hoisted(() => ({ appData: '', userData: '', sessionData: '' }));
vi.mock('electron', () => ({
  app: {
    getPath: (name: keyof typeof profile) => profile[name],
    setPath: (name: 'userData' | 'sessionData', value: string) => {
      profile[name] = value;
    },
  },
}));

import { configureUserDataPath } from '../../utils/app-paths';
import { getDb, initDatabase, runMigrations } from '../database';
import { SCHEMA_VERSION } from '../schema';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'mezair-profile-isolation-'));
  profile.appData = path.join(root, 'app-data');
  profile.userData = path.join(root, 'unselected-profile');
  profile.sessionData = path.join(root, 'session-data');
  mkdirSync(profile.appData, { recursive: true });
});

afterEach(() => {
  try {
    const db = getDb();
    if (db.open) db.close();
  } catch {
    // A profile-selection assertion can fail before database initialization.
  }
  rmSync(root, { recursive: true, force: true });
});

function seedDatabase(filename: string, identity: string): void {
  mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  try {
    db.transaction(() => {
      runMigrations(db, 'dark');
      db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run(
        'profile_origin',
        identity,
      );
      db.prepare(
        "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, '2026-01-01', '2026-01-01')",
      ).run(identity, identity);
      db.prepare("UPDATE settings SET llm_provider = 'cursor', theme = 'dark' WHERE id = 1").run();
    })();
  } finally {
    db.close();
  }
}

function retainedProfile(directory: string) {
  seedDatabase(path.join(directory, 'devhub.db'), 'devhub-workspace');
  writeFileSync(path.join(directory, 'credential-settings.json'), '{"identity":"devhub"}');
  const files = readdirSync(directory).sort();
  const bytes = files.map((name) => [name, readFileSync(path.join(directory, name))] as const);
  return (allowAdditionalFiles = false) => {
    if (!allowAdditionalFiles) expect(readdirSync(directory).sort()).toEqual(files);
    for (const [name, original] of bytes) {
      expect(readFileSync(path.join(directory, name)), name).toEqual(original);
    }
  };
}

function expectFreshDatabase(directory: string): void {
  expect(getDb().name).toBe(path.join(directory, 'mezair.db'));
  expect(getDb().prepare('SELECT id FROM workspaces').all()).toEqual([]);
  expect(getDb().prepare('SELECT key, value FROM schema_meta ORDER BY key').all()).toEqual([
    { key: 'schema_version', value: String(SCHEMA_VERSION) },
  ]);
  expect(getDb().prepare('SELECT llm_provider, theme FROM settings WHERE id = 1').get()).toEqual({
    llm_provider: 'codex',
    theme: 'system',
  });
}

describe('Mezair profile isolation', () => {
  it.each(['devhub', 'DevHub'])('does not copy a retained %s profile on first launch', (name) => {
    const oldDirectory = path.join(profile.appData, name);
    const expectRetained = retainedProfile(oldDirectory);
    const target = path.join(profile.appData, 'Mezair');

    configureUserDataPath();
    initDatabase('system');

    expect(profile.userData).toBe(target);
    expectFreshDatabase(target);
    expect(existsSync(path.join(target, 'devhub.db'))).toBe(false);
    expect(existsSync(path.join(target, 'credential-settings.json'))).toBe(false);
    expectRetained();
  });

  it('creates a fresh database beside a retained database in the selected profile', () => {
    const target = path.join(profile.appData, 'Mezair');
    const expectRetained = retainedProfile(target);

    configureUserDataPath();
    initDatabase('system');

    expectFreshDatabase(target);
    expectRetained(true);
    // The new database has its own WAL files; the retained database is not opened.
    expect(existsSync(path.join(target, 'devhub.db-wal'))).toBe(false);
    expect(existsSync(path.join(target, 'devhub.db-shm'))).toBe(false);
  });

  it('retains the current Mezair database and settings across startup', () => {
    const target = path.join(profile.appData, 'Mezair');
    const oldDirectory = path.join(profile.appData, 'DevHub');
    const expectRetained = retainedProfile(oldDirectory);
    seedDatabase(path.join(target, 'mezair.db'), 'mezair-workspace');

    configureUserDataPath();
    initDatabase('system');

    expect(getDb().name).toBe(path.join(target, 'mezair.db'));
    expect(getDb().prepare('SELECT id FROM workspaces').all()).toEqual([
      { id: 'mezair-workspace' },
    ]);
    expect(
      getDb().prepare("SELECT value FROM schema_meta WHERE key = 'profile_origin'").get(),
    ).toEqual({
      value: 'mezair-workspace',
    });
    expect(getDb().prepare('SELECT llm_provider, theme FROM settings WHERE id = 1').get()).toEqual({
      llm_provider: 'cursor',
      theme: 'dark',
    });
    expectRetained();
  });

  it('keeps an explicit development profile separate from retained profiles', () => {
    const expectRetained = retainedProfile(path.join(profile.appData, 'devhub'));
    const target = path.join(root, 'development-profile');
    const previousSessionData = profile.sessionData;

    configureUserDataPath({ developmentPath: `  ${target}  ` });
    initDatabase('system');

    expect(profile.userData).toBe(target);
    expect(profile.sessionData).toBe(previousSessionData);
    expectFreshDatabase(target);
    expect(existsSync(path.join(profile.appData, 'Mezair'))).toBe(false);
    expectRetained();
  });

  it('isolates preview user and session data even when a development override is set', () => {
    const expectRetained = retainedProfile(path.join(profile.appData, 'DevHub'));
    const developmentPath = path.join(root, 'development-profile');
    const previewDirectory = path.join('Mezair Preview', 'pr-97-fixture');
    const target = path.join(profile.appData, previewDirectory);

    configureUserDataPath({ previewDirectory, developmentPath });
    initDatabase('system');

    expect(profile.userData).toBe(target);
    expect(profile.sessionData).toBe(target);
    expectFreshDatabase(target);
    expect(existsSync(developmentPath)).toBe(false);
    expect(existsSync(path.join(profile.appData, 'Mezair'))).toBe(false);
    expectRetained();
  });
});

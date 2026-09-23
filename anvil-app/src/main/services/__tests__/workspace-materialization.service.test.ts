import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema';
import { SYNC_ENTITY_WORKSPACE_DEFINITION } from '../../../shared/sync-mesh';

const db = new Database(':memory:');
db.exec(SCHEMA_SQL);
db.prepare('INSERT INTO settings (id) VALUES (1)').run();

vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf-8'),
    decryptString: (encrypted: Buffer) => encrypted.toString('utf-8').slice('enc:'.length),
  },
  dialog: {},
  BrowserWindow: class {},
}));

import {
  linkWorkspaceRepo,
  listWorkspaceMaterializationOps,
  purgeQuarantinedCheckout,
  recoverWorkspaceMaterializations,
  removeWorkspaceCheckout,
  setWorkspaceMaterializationRootForTests,
  startWorkspaceClone,
} from '../workspace-materialization.service';
import type { WorkspaceMaterializationStage } from '../../../shared/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const testRoot = mkdtempSync(join(tmpdir(), 'anvil-ws02-'));
const dirsToClean: string[] = [];

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
  setWorkspaceMaterializationRootForTests(null);
});

function tmpdirOf(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirsToClean.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

interface RemoteFixture {
  remote: string;
  sha: string;
  workDir: string;
}

/** Create a real git remote as a bare repo with one commit on main. */
function makeRemote(prefix = 'anvil-ws02-src-', mutate?: (dir: string) => void): RemoteFixture {
  const workDir = tmpdirOf(prefix);
  git(workDir, 'init', '-b', 'main');
  git(workDir, 'config', 'user.name', 'WS02 Test');
  git(workDir, 'config', 'user.email', 'ws02@example.invalid');
  git(workDir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(workDir, 'file.txt'), 'content\n');
  git(workDir, 'add', '.');
  git(workDir, 'commit', '-m', 'initial');
  mutate?.(workDir);
  const sha = git(workDir, 'rev-parse', 'HEAD');
  const remoteParent = tmpdirOf('anvil-ws02-remote-');
  const remote = join(remoteParent, 'remote.git');
  git(remoteParent, 'init', '--bare', '-b', 'main', 'remote.git');
  git(workDir, 'remote', 'add', 'origin', remote);
  git(workDir, 'push', 'origin', 'main');
  return { remote, sha, workDir };
}

function makeWorkspace(name = 'ws'): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO workspaces (id, name, definition_state, created_at, updated_at)
     VALUES (?, ?, 'needs-setup', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')`,
  ).run(id, name);
  return id;
}

function addDefinition(
  workspaceId: string,
  opts: { name?: string; remoteUrl?: string | null; defaultBranch?: string | null } = {},
): string {
  const portableId = randomUUID();
  db.prepare(
    `INSERT INTO workspace_repo_definitions
       (workspace_id, portable_id, name, remote_url, default_branch, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')`,
  ).run(
    workspaceId,
    portableId,
    opts.name ?? 'repo',
    opts.remoteUrl ?? null,
    opts.defaultBranch ?? null,
  );
  return portableId;
}

function definitionState(workspaceId: string): string {
  return (
    db.prepare('SELECT definition_state FROM workspaces WHERE id = ?').get(workspaceId) as {
      definition_state: string;
    }
  ).definition_state;
}

function mappedRepoId(workspaceId: string, portableId: string): string | null {
  return (
    db
      .prepare(
        'SELECT mapped_repo_id FROM workspace_repo_definitions WHERE workspace_id = ? AND portable_id = ?',
      )
      .get(workspaceId, portableId) as { mapped_repo_id: string | null }
  ).mapped_repo_id;
}

function stageRow(
  opId: string,
  portableId: string,
): {
  stage: WorkspaceMaterializationStage;
  stage_reason: string | null;
  destination: string | null;
  staging_path: string | null;
  resolved_commit: string | null;
  repo_id: string | null;
  evidence_json: string;
} {
  return db
    .prepare(
      'SELECT * FROM workspace_materialization_repo_stages WHERE op_id = ? AND portable_id = ?',
    )
    .get(opId, portableId) as ReturnType<typeof stageRow>;
}

/** Insert a fake 'running' op + stage row to simulate a mid-stage crash. */
function insertCrashedCloneOp(opts: {
  opId?: string;
  workspaceId: string;
  portableId: string;
  remoteUrl: string;
  stage: WorkspaceMaterializationStage;
  destination?: string;
  stagingPath?: string;
  resolvedCommit?: string;
  evidence?: Record<string, unknown>;
}): string {
  const opId = opts.opId ?? randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workspace_materialization_ops
       (id, workspace_id, kind, definition_revision, request_key, request_json, state,
        created_at, updated_at)
     VALUES (?, ?, 'clone', 'rev', ?, '{}', 'running', ?, ?)`,
  ).run(opId, opts.workspaceId, `key-${opId}`, now, now);
  db.prepare(
    `INSERT INTO workspace_materialization_repo_stages
       (op_id, portable_id, remote_url, destination, staging_path, ownership_intent,
        stage, resolved_commit, evidence_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'anvil-created', ?, ?, ?, ?, ?)`,
  ).run(
    opId,
    opts.portableId,
    opts.remoteUrl,
    opts.destination ?? null,
    opts.stagingPath ?? join(testRoot, 'mesh-staging', opId, opts.portableId),
    opts.stage,
    opts.resolvedCommit ?? null,
    JSON.stringify(opts.evidence ?? {}),
    now,
    now,
  );
  return opId;
}

function markWorkspaceSynced(workspaceId: string): void {
  db.prepare(
    `INSERT INTO sync_bindings
       (id, backend_id, account_id, dataset_epoch, entity_type, entity_id, created_at, updated_at)
     VALUES (?, 'be', 'ac', 'ep', ?, ?, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')`,
  ).run(randomUUID(), SYNC_ENTITY_WORKSPACE_DEFINITION, workspaceId);
}

beforeEach(() => {
  for (const table of [
    'workspace_materialization_repo_stages',
    'workspace_materialization_ops',
    'workspace_repo_definitions',
    'workspace_repos',
    'workspaces',
    'repo_index_jobs',
    'module_summaries',
    'repo_summaries',
    'repos',
    'mesh_attempts',
    'sync_bindings',
  ]) {
    db.exec(`DELETE FROM ${table}`);
  }
  for (const dir of dirsToClean.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  rmSync(join(testRoot, 'mesh-staging'), { recursive: true, force: true });
  rmSync(join(testRoot, 'quarantine'), { recursive: true, force: true });
  setWorkspaceMaterializationRootForTests(testRoot);
});

// ---------------------------------------------------------------------------
// Clone
// ---------------------------------------------------------------------------

describe('startWorkspaceClone', () => {
  it('clones to staging, verifies, publishes the mapping, and flips readiness', async () => {
    const { remote, sha } = makeRemote();
    const workspaceId = makeWorkspace();
    const portableId = addDefinition(workspaceId, {
      name: 'myrepo',
      remoteUrl: remote,
      defaultBranch: 'main',
    });
    const destinationRoot = join(tmpdirOf('anvil-ws02-dest-'), 'root');

    const result = await startWorkspaceClone({ workspaceId, destinationRoot });

    expect(result.status).toBe('completed');
    expect(result.repos).toHaveLength(1);
    const repo = result.repos[0];
    expect(repo.stage).toBe('mapping-published');
    expect(repo.resolvedCommit).toBe(sha);
    expect(repo.destination).toBeDefined();
    expect(existsSync(join(repo.destination!, '.git'))).toBe(true);
    // Nothing is left behind in staging.
    expect(existsSync(join(testRoot, 'mesh-staging', result.opId))).toBe(false);

    const repoId = mappedRepoId(workspaceId, portableId);
    expect(repoId).not.toBeNull();
    expect(repoId).toBe(repo.repoId);
    expect(definitionState(workspaceId)).toBe('ready');
    expect(git(repo.destination!, 'rev-parse', 'HEAD')).toBe(sha);
    expect(git(repo.destination!, 'remote', 'get-url', 'origin')).toBe(remote);

    const row = db.prepare('SELECT * FROM repos WHERE id = ?').get(repoId) as {
      path: string;
      remote_url: string;
    };
    expect(row.path).toBe(repo.destination);
    expect(row.remote_url).toBe(remote);
  });

  it('checks out a pinned commit detached from the branch', async () => {
    const fixture = makeRemote();
    // Add a second commit so the pinned sha differs from remote HEAD.
    writeFileSync(join(fixture.workDir, 'second.txt'), 'more\n');
    git(fixture.workDir, 'add', '.');
    git(fixture.workDir, 'commit', '-m', 'second');
    git(fixture.workDir, 'push', 'origin', 'main');

    const workspaceId = makeWorkspace();
    const portableId = addDefinition(workspaceId, {
      name: 'pinned',
      remoteUrl: fixture.remote,
    });
    const destinationRoot = join(tmpdirOf('anvil-ws02-dest-'), 'root');

    const result = await startWorkspaceClone({
      workspaceId,
      destinationRoot,
      repos: [{ portableId, commit: fixture.sha }],
    });

    expect(result.status).toBe('completed');
    expect(result.repos[0].resolvedCommit).toBe(fixture.sha);
    expect(git(result.repos[0].destination!, 'rev-parse', 'HEAD')).toBe(fixture.sha);
  });

  it('suffixes the destination when the name collides, without clobbering', async () => {
    const { remote } = makeRemote();
    const workspaceId = makeWorkspace();
    const portableId = addDefinition(workspaceId, { name: 'taken', remoteUrl: remote });
    const destinationRoot = join(tmpdirOf('anvil-ws02-dest-'), 'root');
    mkdirSync(join(destinationRoot, 'taken'), { recursive: true });
    writeFileSync(join(destinationRoot, 'taken', 'keep.me'), 'do not touch\n');

    const result = await startWorkspaceClone({ workspaceId, destinationRoot });

    expect(result.status).toBe('completed');
    const destination = result.repos[0].destination!;
    expect(destination).not.toBe(join(destinationRoot, 'taken'));
    expect(destination).toContain(`taken-${result.opId.slice(0, 8)}`);
    expect(existsSync(join(destination, '.git'))).toBe(true);
    // The pre-existing directory is untouched.
    expect(readFileSync(join(destinationRoot, 'taken', 'keep.me'), 'utf8')).toBe('do not touch\n');
    expect(mappedRepoId(workspaceId, portableId)).not.toBeNull();
  });

  it('preserves a successful clone when a second repo fails (partial multi-repo)', async () => {
    const { remote } = makeRemote();
    const workspaceId = makeWorkspace();
    const good = addDefinition(workspaceId, { name: 'good', remoteUrl: remote });
    const bad = addDefinition(workspaceId, {
      name: 'bad',
      remoteUrl: join(testRoot, 'does-not-exist.git'),
    });
    const destinationRoot = join(tmpdirOf('anvil-ws02-dest-'), 'root');

    const result = await startWorkspaceClone({ workspaceId, destinationRoot });

    expect(result.status).toBe('partial');
    const goodResult = result.repos.find((r) => r.portableId === good)!;
    const badResult = result.repos.find((r) => r.portableId === bad)!;
    expect(goodResult.stage).toBe('mapping-published');
    expect(badResult.stage).toBe('failed');
    expect(badResult.reason).toBe('clone-failed');
    // The successful repo stays published; the failed one stays unmapped.
    expect(mappedRepoId(workspaceId, good)).not.toBeNull();
    expect(mappedRepoId(workspaceId, bad)).toBeNull();
    // Aggregate readiness requires every required repo — still needs setup.
    expect(definitionState(workspaceId)).toBe('needs-setup');
    const op = listWorkspaceMaterializationOps(workspaceId)[0];
    expect(op.state).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// Transport policy
// ---------------------------------------------------------------------------

describe('transport policy', () => {
  it('rejects a file:// remote on a synced definition before any fs write', async () => {
    const workspaceId = makeWorkspace();
    markWorkspaceSynced(workspaceId);
    const portableId = addDefinition(workspaceId, {
      name: 'synced',
      remoteUrl: 'file:///etc/passwd',
    });
    const destinationRoot = join(tmpdirOf('anvil-ws02-dest-'), 'root');

    const result = await startWorkspaceClone({ workspaceId, destinationRoot });

    expect(result.status).toBe('failed');
    expect(result.repos[0].stage).toBe('failed');
    expect(result.repos[0].reason).toBe('local-remote-rejected');
    // No filesystem writes happened: no destination root, no staging dir.
    expect(existsSync(destinationRoot)).toBe(false);
    expect(existsSync(join(testRoot, 'mesh-staging'))).toBe(false);
    expect(mappedRepoId(workspaceId, portableId)).toBeNull();
  });

  it('rejects embedded credentials and remote helpers even when unsynced', async () => {
    const workspaceId = makeWorkspace();
    const creds = addDefinition(workspaceId, {
      name: 'creds',
      remoteUrl: 'https://user:secret@github.com/org/repo.git',
    });
    const helper = addDefinition(workspaceId, {
      name: 'helper',
      remoteUrl: 'ext::ssh -o stuff %s org/repo',
    });
    const plain = addDefinition(workspaceId, {
      name: 'plain',
      remoteUrl: 'git://github.com/org/repo.git',
    });
    const destinationRoot = join(tmpdirOf('anvil-ws02-dest-'), 'root');

    const result = await startWorkspaceClone({ workspaceId, destinationRoot });

    const byPortable = new Map(result.repos.map((r) => [r.portableId, r]));
    expect(byPortable.get(creds)!.reason).toBe('embedded-credentials-rejected');
    expect(byPortable.get(helper)!.reason).toBe('remote-helper-rejected');
    expect(byPortable.get(plain)!.reason).toBe('transport-not-approved');
    expect(existsSync(join(testRoot, 'mesh-staging'))).toBe(false);
  });

  it('allows a local-path remote for a local (unsynced) definition', async () => {
    const { remote } = makeRemote();
    const workspaceId = makeWorkspace();
    addDefinition(workspaceId, { name: 'local', remoteUrl: remote });
    const result = await startWorkspaceClone({
      workspaceId,
      destinationRoot: join(tmpdirOf('anvil-ws02-dest-'), 'root'),
    });
    expect(result.status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// Crash recovery
// ---------------------------------------------------------------------------

describe('crash recovery', () => {
  it('publishes a verified staging clone whose move was interrupted', async () => {
    const { remote, sha } = makeRemote();
    const workspaceId = makeWorkspace();
    const portableId = addDefinition(workspaceId, { name: 'crash', remoteUrl: remote });
    const destinationRoot = tmpdirOf('anvil-ws02-dest-');
    const destination = join(destinationRoot, 'crash');

    // Simulate a crash right after commit-recorded: staging clone on disk.
    const opId = randomUUID();
    const staging = join(testRoot, 'mesh-staging', opId, portableId);
    git(testRoot, 'clone', remote, staging);
    insertCrashedCloneOp({
      opId,
      workspaceId,
      portableId,
      remoteUrl: remote,
      stage: 'commit-recorded',
      destination,
      stagingPath: staging,
      resolvedCommit: sha,
    });
    await recoverWorkspaceMaterializations();

    const stage = stageRow(opId, portableId);
    expect(stage.stage).toBe('mapping-published');
    expect(existsSync(join(destination, '.git'))).toBe(true);
    expect(existsSync(staging)).toBe(false);
    expect(mappedRepoId(workspaceId, portableId)).not.toBeNull();
    expect(definitionState(workspaceId)).toBe('ready');
  });

  it('wipes an unverified partial clone and restarts it', async () => {
    const { remote } = makeRemote();
    const workspaceId = makeWorkspace();
    const portableId = addDefinition(workspaceId, { name: 'partial', remoteUrl: remote });
    const destinationRoot = tmpdirOf('anvil-ws02-dest-');
    const destination = join(destinationRoot, 'partial');

    const opId = randomUUID();
    const staging = join(testRoot, 'mesh-staging', opId, portableId);
    // Garbage in the staging dir — a partial clone that was never verified.
    mkdirSync(join(staging, '.git', 'objects'), { recursive: true });
    insertCrashedCloneOp({
      opId,
      workspaceId,
      portableId,
      remoteUrl: remote,
      stage: 'cloned-to-staging',
      destination,
      stagingPath: staging,
    });

    await recoverWorkspaceMaterializations();

    const stage = stageRow(opId, portableId);
    expect(stage.stage).toBe('mapping-published');
    expect(existsSync(join(destination, '.git'))).toBe(true);
    expect(mappedRepoId(workspaceId, portableId)).not.toBeNull();
  });

  it('restarts a stage whose journal row has no filesystem evidence', async () => {
    const { remote } = makeRemote();
    const workspaceId = makeWorkspace();
    const portableId = addDefinition(workspaceId, { name: 'journal', remoteUrl: remote });
    const destination = join(tmpdirOf('anvil-ws02-dest-'), 'journal');

    const opId = insertCrashedCloneOp({
      workspaceId,
      portableId,
      remoteUrl: remote,
      stage: 'pending',
      destination,
    });

    await recoverWorkspaceMaterializations();

    expect(stageRow(opId, portableId).stage).toBe('mapping-published');
    expect(existsSync(join(destination, '.git'))).toBe(true);
    expect(mappedRepoId(workspaceId, portableId)).not.toBeNull();
  });

  it('detects a shallow staged clone during recovery verification', async () => {
    const { remote } = makeRemote();
    const workspaceId = makeWorkspace();
    const portableId = addDefinition(workspaceId, { name: 'shallow', remoteUrl: remote });
    const destination = join(tmpdirOf('anvil-ws02-dest-'), 'shallow');

    const opId = randomUUID();
    const staging = join(testRoot, 'mesh-staging', opId, portableId);
    // file:// is required — a plain local path clone ignores --depth.
    const fileRemote = `file://${remote}`;
    git(testRoot, 'clone', '--depth', '1', fileRemote, staging);
    expect(git(staging, 'rev-parse', '--is-shallow-repository')).toBe('true');
    insertCrashedCloneOp({
      opId,
      workspaceId,
      portableId,
      remoteUrl: fileRemote,
      stage: 'cloned-to-staging',
      destination,
      stagingPath: staging,
    });

    await recoverWorkspaceMaterializations();

    const stage = stageRow(opId, portableId);
    expect(stage.stage).toBe('unsupported');
    expect(stage.stage_reason).toBe('shallow');
    expect(mappedRepoId(workspaceId, portableId)).toBeNull();
    expect(definitionState(workspaceId)).toBe('needs-setup');
  });
});

// ---------------------------------------------------------------------------
// Unsupported-case detection
// ---------------------------------------------------------------------------

describe('unsupported-case detection', () => {
  it('marks a checkout with submodules unsupported before readiness', async () => {
    const inner = tmpdirOf('anvil-ws02-inner-');
    git(inner, 'init', '-b', 'main');
    git(inner, 'config', 'user.name', 'WS02 Test');
    git(inner, 'config', 'user.email', 'ws02@example.invalid');
    git(inner, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(inner, 'inner.txt'), 'inner\n');
    git(inner, 'add', '.');
    git(inner, 'commit', '-m', 'inner');

    const fixture = makeRemote('anvil-ws02-outer-', (dir) => {
      git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', inner, 'sub');
      git(dir, 'commit', '-am', 'add submodule');
    });

    const workspaceId = makeWorkspace();
    const portableId = addDefinition(workspaceId, {
      name: 'with-sub',
      remoteUrl: fixture.remote,
    });
    const result = await startWorkspaceClone({
      workspaceId,
      destinationRoot: join(tmpdirOf('anvil-ws02-dest-'), 'root'),
    });

    expect(result.status).toBe('failed');
    expect(result.repos[0].stage).toBe('unsupported');
    expect(result.repos[0].reason).toBe('submodules');
    expect(mappedRepoId(workspaceId, portableId)).toBeNull();
  });

  it('marks a checkout with LFS pointers unsupported', async () => {
    const fixture = makeRemote('anvil-ws02-lfs-', (dir) => {
      writeFileSync(join(dir, '.gitattributes'), '*.bin filter=lfs\n');
      writeFileSync(
        join(dir, 'asset.bin'),
        'version https://git-lfs.github.com/spec/v1\n' + 'oid sha256:0123456789abcdef\nsize 123\n',
      );
      git(dir, 'add', '.');
      git(dir, 'commit', '-m', 'lfs');
    });

    const workspaceId = makeWorkspace();
    const portableId = addDefinition(workspaceId, {
      name: 'lfs-repo',
      remoteUrl: fixture.remote,
    });
    const result = await startWorkspaceClone({
      workspaceId,
      destinationRoot: join(tmpdirOf('anvil-ws02-dest-'), 'root'),
    });

    expect(result.repos[0].stage).toBe('unsupported');
    expect(result.repos[0].reason).toBe('lfs');
    expect(mappedRepoId(workspaceId, portableId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Concurrency: attach + conflict
// ---------------------------------------------------------------------------

describe('concurrent operations', () => {
  it('attaches identical pinned inputs to the same operation row', async () => {
    const { remote } = makeRemote();
    const workspaceId = makeWorkspace();
    const portableId = addDefinition(workspaceId, { name: 'shared', remoteUrl: remote });
    const destinationRoot = join(tmpdirOf('anvil-ws02-dest-'), 'root');
    const request = { workspaceId, destinationRoot, repos: [{ portableId }] };

    const [first, second] = await Promise.all([
      startWorkspaceClone(request),
      startWorkspaceClone(request),
    ]);

    expect(first.opId).toBe(second.opId);
    expect(first.status).toBe('completed');
    expect(second.status).toBe('completed');
    const ops = listWorkspaceMaterializationOps(workspaceId);
    expect(ops).toHaveLength(1);
  });

  it('conflicts when different inputs target the running op', async () => {
    const { remote } = makeRemote();
    const workspaceId = makeWorkspace();
    const portableId = addDefinition(workspaceId, { name: 'raced', remoteUrl: remote });
    const destinationRoot = join(tmpdirOf('anvil-ws02-dest-'), 'root');

    const running = startWorkspaceClone({
      workspaceId,
      destinationRoot,
      repos: [{ portableId }],
    });
    // Different pinned input (commit) for the same portable id while running.
    await expect(
      startWorkspaceClone({
        workspaceId,
        destinationRoot,
        repos: [{ portableId, commit: '0'.repeat(40) }],
      }),
    ).rejects.toThrow(/already running/i);

    const result = await running;
    expect(result.status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// Linking
// ---------------------------------------------------------------------------

describe('linkWorkspaceRepo', () => {
  it('links an existing checkout whose remote matches the definition', async () => {
    const { remote } = makeRemote();
    const workspaceId = makeWorkspace();
    const portableId = addDefinition(workspaceId, { name: 'linked', remoteUrl: remote });

    // An existing local checkout of that remote.
    const checkout = join(tmpdirOf('anvil-ws02-existing-'), 'checkout');
    git(testRoot, 'clone', remote, checkout);

    const result = await linkWorkspaceRepo(workspaceId, portableId, checkout);

    expect(result.status).toBe('linked');
    expect(result.repoId).toBe(mappedRepoId(workspaceId, portableId));
    expect(definitionState(workspaceId)).toBe('ready');
  });

  it('links a local-only checkout to a definition without a remote', async () => {
    const workspaceId = makeWorkspace();
    const portableId = addDefinition(workspaceId, { name: 'local-only', remoteUrl: null });

    const checkout = join(tmpdirOf('anvil-ws02-existing-'), 'checkout');
    git(testRoot, 'init', '-b', 'main', checkout);
    git(checkout, 'config', 'user.name', 'WS02 Test');
    git(checkout, 'config', 'user.email', 'ws02@example.invalid');
    writeFileSync(join(checkout, 'a.txt'), 'a\n');
    git(checkout, 'add', '.');
    git(checkout, 'commit', '-m', 'init');

    const result = await linkWorkspaceRepo(workspaceId, portableId, checkout);
    expect(result.status).toBe('linked');
    expect(definitionState(workspaceId)).toBe('ready');
  });

  it('records remote divergence for review instead of mapping', async () => {
    const { remote } = makeRemote();
    const other = makeRemote('anvil-ws02-other-');
    const workspaceId = makeWorkspace();
    const portableId = addDefinition(workspaceId, { name: 'div', remoteUrl: remote });
    const checkout = join(tmpdirOf('anvil-ws02-existing-'), 'checkout');
    git(testRoot, 'clone', other.remote, checkout);

    const result = await linkWorkspaceRepo(workspaceId, portableId, checkout);

    expect(result.status).toBe('divergence');
    expect(result.expectedRemoteUrl).toContain('remote.git');
    expect(result.actualRemoteUrl).toContain('remote.git');
    expect(result.expectedRemoteUrl).not.toBe(result.actualRemoteUrl);
    expect(mappedRepoId(workspaceId, portableId)).toBeNull();
    const op = listWorkspaceMaterializationOps(workspaceId).find((o) => o.id === result.opId);
    expect(op?.state).toBe('awaiting-review');
  });

  it('fails when the path is not a git repository', async () => {
    const workspaceId = makeWorkspace();
    const portableId = addDefinition(workspaceId, { name: 'nogit' });
    const notARepo = tmpdirOf('anvil-ws02-existing-');

    const result = await linkWorkspaceRepo(workspaceId, portableId, notARepo);
    expect(result.status).toBe('failed');
    expect(result.error).toBe('not-a-git-repo');
  });
});

// ---------------------------------------------------------------------------
// Safe removal
// ---------------------------------------------------------------------------

describe('removeWorkspaceCheckout', () => {
  async function cloneOne(): Promise<{
    workspaceId: string;
    portableId: string;
    destination: string;
    repoId: string;
    remote: string;
  }> {
    const { remote } = makeRemote();
    const workspaceId = makeWorkspace();
    const portableId = addDefinition(workspaceId, { name: 'victim', remoteUrl: remote });
    const destinationRoot = join(tmpdirOf('anvil-ws02-dest-'), 'root');
    const result = await startWorkspaceClone({ workspaceId, destinationRoot });
    const repo = result.repos[0];
    return {
      workspaceId,
      portableId,
      destination: repo.destination!,
      repoId: repo.repoId!,
      remote,
    };
  }

  it('detaches the mapping by default and never deletes files', async () => {
    const { workspaceId, portableId, destination } = await cloneOne();

    const result = await removeWorkspaceCheckout(workspaceId, portableId);

    expect(result.status).toBe('detached');
    expect(mappedRepoId(workspaceId, portableId)).toBeNull();
    expect(existsSync(join(destination, '.git'))).toBe(true);
    expect(definitionState(workspaceId)).toBe('needs-setup');
  });

  it('returns not-mapped when nothing is mapped', async () => {
    const workspaceId = makeWorkspace();
    const portableId = addDefinition(workspaceId, { name: 'unmapped' });
    const result = await removeWorkspaceCheckout(workspaceId, portableId, {
      deleteCheckout: true,
    });
    expect(result.status).toBe('not-mapped');
  });

  it('quarantines a clean Anvil-created checkout on deleteCheckout', async () => {
    const { workspaceId, portableId, destination, repoId } = await cloneOne();

    const result = await removeWorkspaceCheckout(workspaceId, portableId, {
      deleteCheckout: true,
    });

    expect(result.status).toBe('quarantined');
    expect(result.quarantineId).toBeDefined();
    expect(existsSync(destination)).toBe(false);
    expect(result.quarantinePath).toBeDefined();
    expect(existsSync(join(result.quarantinePath!, '.git'))).toBe(true);
    expect(result.quarantinePath).toContain(join(testRoot, 'quarantine'));
    expect(mappedRepoId(workspaceId, portableId)).toBeNull();
    // The repos row follows the quarantined path so the checkout is recoverable.
    const repo = db.prepare('SELECT path FROM repos WHERE id = ?').get(repoId) as {
      path: string;
    };
    expect(repo.path).toBe(result.quarantinePath);
  });

  it('purges a quarantined checkout on a second explicit call', async () => {
    const { workspaceId, portableId } = await cloneOne();
    const removed = await removeWorkspaceCheckout(workspaceId, portableId, {
      deleteCheckout: true,
    });
    expect(removed.status).toBe('quarantined');
    const quarantinePath = removed.quarantinePath!;

    await purgeQuarantinedCheckout(removed.quarantineId!);

    expect(existsSync(quarantinePath)).toBe(false);
  });

  it('refuses to delete a dirty or untracked checkout', async () => {
    const { workspaceId, portableId, destination } = await cloneOne();
    writeFileSync(join(destination, 'untracked.txt'), 'user work\n');

    const result = await removeWorkspaceCheckout(workspaceId, portableId, {
      deleteCheckout: true,
    });

    expect(result.status).toBe('refused');
    expect(result.refusals).toContain('checkout-dirty');
    expect(existsSync(join(destination, '.git'))).toBe(true);
    expect(mappedRepoId(workspaceId, portableId)).not.toBeNull();
  });

  it('refuses to delete a checkout with unpublished commits', async () => {
    const { workspaceId, portableId, destination } = await cloneOne();
    writeFileSync(join(destination, 'local.txt'), 'committed locally\n');
    git(destination, 'add', '.');
    git(destination, 'config', 'user.name', 'WS02 Test');
    git(destination, 'config', 'user.email', 'ws02@example.invalid');
    git(destination, 'commit', '-m', 'unpublished');

    const result = await removeWorkspaceCheckout(workspaceId, portableId, {
      deleteCheckout: true,
    });

    expect(result.status).toBe('refused');
    expect(result.refusals).toContain('unpublished-commits');
    expect(existsSync(join(destination, '.git'))).toBe(true);
  });

  it('refuses to delete while an active mesh attempt references the repo', async () => {
    const { workspaceId, portableId, repoId } = await cloneOne();
    db.prepare(
      `INSERT INTO mesh_attempts
         (id, job_id, enrollment_id, incarnation, fence, kind, state, manifest_json,
          created_at, updated_at)
       VALUES ('att-1', 'job-1', 'enr', 'inc', 1, 'prepare-workspace', 'running', ?, ?, ?)`,
    ).run(
      JSON.stringify({ repositories: [{ repositoryId: repoId, commit: 'x' }] }),
      new Date().toISOString(),
      new Date().toISOString(),
    );

    const result = await removeWorkspaceCheckout(workspaceId, portableId, {
      deleteCheckout: true,
    });

    expect(result.status).toBe('refused');
    expect(result.refusals).toContain('active-attempt');
  });

  it('refuses to delete a checkout referenced by another workspace', async () => {
    const { workspaceId, portableId, repoId } = await cloneOne();
    const otherWorkspace = makeWorkspace('other');
    db.prepare(
      `INSERT INTO workspace_repos (workspace_id, repo_id, added_at) VALUES (?, ?, ?)`,
    ).run(otherWorkspace, repoId, new Date().toISOString());

    const result = await removeWorkspaceCheckout(workspaceId, portableId, {
      deleteCheckout: true,
    });

    expect(result.status).toBe('refused');
    expect(result.refusals).toContain('other-workspace-references');
  });

  it('never deletes a linked (not Anvil-created) checkout', async () => {
    const { remote } = makeRemote();
    const workspaceId = makeWorkspace();
    const portableId = addDefinition(workspaceId, { name: 'linked', remoteUrl: remote });
    const checkout = join(tmpdirOf('anvil-ws02-existing-'), 'checkout');
    git(testRoot, 'clone', remote, checkout);
    const linked = await linkWorkspaceRepo(workspaceId, portableId, checkout);
    expect(linked.status).toBe('linked');

    const result = await removeWorkspaceCheckout(workspaceId, portableId, {
      deleteCheckout: true,
    });

    expect(result.status).toBe('refused');
    expect(result.refusals).toContain('not-anvil-created');
    expect(existsSync(join(checkout, '.git'))).toBe(true);
    expect(mappedRepoId(workspaceId, portableId)).not.toBeNull();
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../db/schema.js';

// Create an in-memory SQLite DB and mock getDb() before importing the service
const inMemoryDb = new Database(':memory:');
inMemoryDb.exec(SCHEMA_SQL);

vi.mock('../../db/database.js', () => ({
  getDb: () => inMemoryDb,
}));

import {
  createBaSession,
  getBaSession,
  getActiveBaSession,
  endBaSession,
  getOrphanedSessions,
  markSessionOrphaned,
  listBaSessions,
  createBaFinding,
  getBaFinding,
  listBaFindings,
  updateBaFinding,
  deleteBaFinding,
  saveBaMessage,
  loadBaMessages,
  setBaRepoLink,
  getBaRepoLink,
} from '../ba-persistence.service.js';

// Reset tables between tests
beforeEach(() => {
  inMemoryDb.exec('DELETE FROM ba_messages');
  inMemoryDb.exec('DELETE FROM ba_findings');
  inMemoryDb.exec('DELETE FROM ba_repo_links');
  inMemoryDb.exec('DELETE FROM ba_sessions');
});

// ---------------------------------------------------------------------------
// Session CRUD
// ---------------------------------------------------------------------------

describe('createBaSession', () => {
  it('creates a session and returns an id', () => {
    const id = createBaSession({
      workItemId: 'wi-1',
      repoId: 'repo-1',
      spikeBranch: 'spike/wi-1',
      originBranch: 'main',
    });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('persists the session with active status', () => {
    const id = createBaSession({
      workItemId: 'wi-1',
      repoId: 'repo-1',
      spikeBranch: 'spike/wi-1',
      originBranch: 'main',
    });
    const session = getBaSession(id);
    expect(session).not.toBeNull();
    expect(session!.workItemId).toBe('wi-1');
    expect(session!.repoId).toBe('repo-1');
    expect(session!.spikeBranch).toBe('spike/wi-1');
    expect(session!.originBranch).toBe('main');
    expect(session!.status).toBe('active');
    expect(session!.stashRef).toBeUndefined();
    expect(session!.endedAt).toBeUndefined();
  });

  it('persists optional stashRef', () => {
    const id = createBaSession({
      workItemId: 'wi-1',
      repoId: 'repo-1',
      spikeBranch: 'spike/wi-1',
      originBranch: 'main',
      stashRef: 'stash@{0}',
    });
    const session = getBaSession(id);
    expect(session!.stashRef).toBe('stash@{0}');
  });

  it('persists optional worktreePath', () => {
    const id = createBaSession({
      workItemId: 'wi-1',
      repoId: 'repo-1',
      spikeBranch: 'spike/wi-1-abc123',
      originBranch: 'main',
      worktreePath: '/tmp/anvil/ba-spike-worktrees/wi-1/repo-abc123',
    });
    const session = getBaSession(id);
    expect(session!.worktreePath).toBe('/tmp/anvil/ba-spike-worktrees/wi-1/repo-abc123');
  });
});

describe('getBaSession', () => {
  it('returns null for unknown id', () => {
    const result = getBaSession('nonexistent-id');
    expect(result).toBeNull();
  });
});

describe('getActiveBaSession', () => {
  it('returns the active session for a work item', () => {
    createBaSession({
      workItemId: 'wi-2',
      repoId: 'repo-1',
      spikeBranch: 'spike/wi-2',
      originBranch: 'main',
    });
    const session = getActiveBaSession('wi-2');
    expect(session).not.toBeNull();
    expect(session!.status).toBe('active');
  });

  it('returns null when no active session exists', () => {
    const session = getActiveBaSession('wi-no-session');
    expect(session).toBeNull();
  });

  it('returns null when session has been ended', () => {
    const id = createBaSession({
      workItemId: 'wi-3',
      repoId: 'repo-1',
      spikeBranch: 'spike/wi-3',
      originBranch: 'main',
    });
    endBaSession(id);
    const session = getActiveBaSession('wi-3');
    expect(session).toBeNull();
  });
});

describe('endBaSession', () => {
  it('marks session as completed with an endedAt timestamp', () => {
    const id = createBaSession({
      workItemId: 'wi-4',
      repoId: 'repo-1',
      spikeBranch: 'spike/wi-4',
      originBranch: 'main',
    });
    endBaSession(id);
    const session = getBaSession(id);
    expect(session!.status).toBe('completed');
    expect(session!.endedAt).toBeDefined();
  });
});

describe('markSessionOrphaned', () => {
  it('sets status to orphaned', () => {
    const id = createBaSession({
      workItemId: 'wi-5',
      repoId: 'repo-1',
      spikeBranch: 'spike/wi-5',
      originBranch: 'main',
    });
    markSessionOrphaned(id);
    const session = getBaSession(id);
    expect(session!.status).toBe('orphaned');
  });
});

describe('getOrphanedSessions', () => {
  it('returns all orphaned sessions', () => {
    const id1 = createBaSession({
      workItemId: 'wi-6',
      repoId: 'repo-1',
      spikeBranch: 'spike/wi-6',
      originBranch: 'main',
    });
    createBaSession({
      workItemId: 'wi-7',
      repoId: 'repo-1',
      spikeBranch: 'spike/wi-7',
      originBranch: 'main',
    });
    markSessionOrphaned(id1);
    const orphaned = getOrphanedSessions();
    expect(orphaned.length).toBe(1);
    expect(orphaned[0].id).toBe(id1);
    expect(orphaned[0].status).toBe('orphaned');
  });
});

describe('listBaSessions', () => {
  it('lists sessions by workItemId', () => {
    createBaSession({
      workItemId: 'wi-8',
      repoId: 'repo-1',
      spikeBranch: 'spike/wi-8',
      originBranch: 'main',
    });
    createBaSession({
      workItemId: 'wi-8',
      repoId: 'repo-1',
      spikeBranch: 'spike/wi-8-retry',
      originBranch: 'main',
    });
    createBaSession({
      workItemId: 'wi-9',
      repoId: 'repo-1',
      spikeBranch: 'spike/wi-9',
      originBranch: 'main',
    });
    const sessions = listBaSessions('wi-8');
    expect(sessions.length).toBe(2);
    sessions.forEach((s) => expect(s.workItemId).toBe('wi-8'));
  });
});

// ---------------------------------------------------------------------------
// Finding CRUD
// ---------------------------------------------------------------------------

describe('createBaFinding', () => {
  it('creates a finding and returns it', () => {
    const sessionId = createBaSession({
      workItemId: 'wi-f1',
      repoId: 'repo-1',
      spikeBranch: 'spike/wi-f1',
      originBranch: 'main',
    });
    const finding = createBaFinding({
      workItemId: 'wi-f1',
      repoId: 'repo-1',
      sessionId,
      type: 'risk',
      content: 'High memory usage expected',
    });
    expect(finding.id).toBeDefined();
    expect(finding.workItemId).toBe('wi-f1');
    expect(finding.type).toBe('risk');
    expect(finding.content).toBe('High memory usage expected');
    expect(finding.status).toBe('open');
  });

  it('deduplicates findings by workItemId + type + content', () => {
    const sessionId = createBaSession({
      workItemId: 'wi-f2',
      repoId: 'repo-1',
      spikeBranch: 'spike/wi-f2',
      originBranch: 'main',
    });
    const payload = {
      workItemId: 'wi-f2',
      repoId: 'repo-1',
      sessionId,
      type: 'compliance' as const,
      content: 'GDPR compliance required',
    };
    const first = createBaFinding(payload);
    const second = createBaFinding(payload);
    expect(second.id).toBe(first.id);

    const all = listBaFindings('wi-f2');
    expect(all.length).toBe(1);
  });

  it('creates a new finding when content differs', () => {
    const sessionId = createBaSession({
      workItemId: 'wi-f3',
      repoId: 'repo-1',
      spikeBranch: 'spike/wi-f3',
      originBranch: 'main',
    });
    const first = createBaFinding({
      workItemId: 'wi-f3',
      repoId: 'repo-1',
      sessionId,
      type: 'risk',
      content: 'Risk A',
    });
    const second = createBaFinding({
      workItemId: 'wi-f3',
      repoId: 'repo-1',
      sessionId,
      type: 'risk',
      content: 'Risk B',
    });
    expect(second.id).not.toBe(first.id);
    expect(listBaFindings('wi-f3').length).toBe(2);
  });
});

describe('getBaFinding', () => {
  it('returns null for unknown id', () => {
    expect(getBaFinding('nonexistent')).toBeNull();
  });

  it('retrieves an existing finding by id', () => {
    createBaSession({
      workItemId: 'wi-f4',
      repoId: 'repo-1',
      spikeBranch: 'spike/wi-f4',
      originBranch: 'main',
    });
    const finding = createBaFinding({
      workItemId: 'wi-f4',
      repoId: 'repo-1',
      type: 'question',
      content: 'What is the SLA?',
    });
    const retrieved = getBaFinding(finding.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(finding.id);
  });
});

describe('listBaFindings', () => {
  it('returns findings for a given workItemId', () => {
    createBaFinding({
      workItemId: 'wi-list',
      repoId: 'repo-1',
      type: 'risk',
      content: 'Finding 1',
    });
    createBaFinding({
      workItemId: 'wi-list',
      repoId: 'repo-1',
      type: 'feasibility',
      content: 'Finding 2',
    });
    createBaFinding({
      workItemId: 'wi-other',
      repoId: 'repo-1',
      type: 'risk',
      content: 'Should not appear',
    });
    const findings = listBaFindings('wi-list');
    expect(findings.length).toBe(2);
    findings.forEach((f) => expect(f.workItemId).toBe('wi-list'));
  });
});

describe('updateBaFinding', () => {
  it('updates the status of a finding', () => {
    const finding = createBaFinding({
      workItemId: 'wi-upd',
      repoId: 'repo-1',
      type: 'risk',
      content: 'Needs updating',
    });
    updateBaFinding(finding.id, { status: 'resolved' });
    const updated = getBaFinding(finding.id);
    expect(updated!.status).toBe('resolved');
  });

  it('updates the content of a finding', () => {
    const finding = createBaFinding({
      workItemId: 'wi-upd2',
      repoId: 'repo-1',
      type: 'question',
      content: 'Old content',
    });
    updateBaFinding(finding.id, { content: 'New content' });
    const updated = getBaFinding(finding.id);
    expect(updated!.content).toBe('New content');
  });
});

describe('deleteBaFinding', () => {
  it('removes a finding from the db', () => {
    const finding = createBaFinding({
      workItemId: 'wi-del',
      repoId: 'repo-1',
      type: 'dependency',
      content: 'To be deleted',
    });
    deleteBaFinding(finding.id);
    expect(getBaFinding(finding.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Message CRUD
// ---------------------------------------------------------------------------

describe('saveBaMessage / loadBaMessages', () => {
  it('saves and loads messages for a session', () => {
    const sessionId = createBaSession({
      workItemId: 'wi-msg',
      repoId: 'repo-1',
      spikeBranch: 'spike/wi-msg',
      originBranch: 'main',
    });
    saveBaMessage({
      sessionId,
      role: 'user',
      content: 'Hello',
    });
    saveBaMessage({
      sessionId,
      role: 'assistant',
      content: 'Hi there',
      eventType: 'text',
    });

    const messages = loadBaMessages(sessionId);
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('Hello');
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toBe('Hi there');
    expect(messages[1].eventType).toBe('text');
  });

  it('returns empty array when no messages exist for session', () => {
    const messages = loadBaMessages('nonexistent-session');
    expect(messages).toEqual([]);
  });

  it('does not return messages from other sessions', () => {
    const session1 = createBaSession({
      workItemId: 'wi-ms1',
      repoId: 'repo-1',
      spikeBranch: 'spike/wi-ms1',
      originBranch: 'main',
    });
    const session2 = createBaSession({
      workItemId: 'wi-ms2',
      repoId: 'repo-1',
      spikeBranch: 'spike/wi-ms2',
      originBranch: 'main',
    });
    saveBaMessage({ sessionId: session1, role: 'user', content: 'Session 1 message' });
    saveBaMessage({ sessionId: session2, role: 'user', content: 'Session 2 message' });

    const messages1 = loadBaMessages(session1);
    expect(messages1.length).toBe(1);
    expect(messages1[0].content).toBe('Session 1 message');
  });

  it('preserves insertion order', () => {
    const sessionId = createBaSession({
      workItemId: 'wi-order',
      repoId: 'repo-1',
      spikeBranch: 'spike/wi-order',
      originBranch: 'main',
    });
    saveBaMessage({ sessionId, role: 'user', content: 'First' });
    saveBaMessage({ sessionId, role: 'assistant', content: 'Second' });
    saveBaMessage({ sessionId, role: 'user', content: 'Third' });

    const messages = loadBaMessages(sessionId);
    expect(messages.map((m) => m.content)).toEqual(['First', 'Second', 'Third']);
  });
});

// ---------------------------------------------------------------------------
// Repo links
// ---------------------------------------------------------------------------

describe('setBaRepoLink / getBaRepoLink', () => {
  it('sets and retrieves a repo link', () => {
    setBaRepoLink('wi-link', 'repo-link');
    const link = getBaRepoLink('wi-link');
    expect(link).not.toBeNull();
    expect(link!.workItemId).toBe('wi-link');
    expect(link!.repoId).toBe('repo-link');
    expect(link!.linkedAt).toBeDefined();
  });

  it('returns null when no link exists', () => {
    const link = getBaRepoLink('wi-no-link');
    expect(link).toBeNull();
  });

  it('overwrites an existing link', () => {
    setBaRepoLink('wi-ow', 'repo-original');
    setBaRepoLink('wi-ow', 'repo-new');
    const link = getBaRepoLink('wi-ow');
    expect(link!.repoId).toBe('repo-new');
  });
});

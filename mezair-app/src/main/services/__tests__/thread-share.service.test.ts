import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteChatRecord } from '../../../shared/remote-chat.js';
import type { ChatAttachment, ChatMessage, ChatThread } from '../../../shared/types.js';
import type { ThreadContinuation } from '../../../../cloud/contract/thread-pickup.js';

const mocks = vi.hoisted(() => ({
  thread: null as ChatThread | null,
  messages: [] as ChatMessage[],
  remoteChats: [] as RemoteChatRecord[],
  artifacts: [] as Array<Record<string, unknown>>,
  surfaces: [] as Array<Record<string, unknown>>,
  getChatThread: vi.fn(),
  loadChatHistory: vi.fn(),
  listAgentUISurfaces: vi.fn(),
  getRemoteChat: vi.fn(),
  listRemoteChats: vi.fn(),
}));

vi.mock('../../db/database.js', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      all: () => (sql.includes('chat_artifacts') ? mocks.artifacts : []),
      get: (_itemType: string, _itemId: string) =>
        sql.includes('MAX(version)') ? { version: null } : undefined,
    }),
  }),
}));
vi.mock('../chat-persistence.service.js', () => ({
  getChatThread: mocks.getChatThread,
  loadChatHistory: mocks.loadChatHistory,
}));
vi.mock('../agent-ui-intent.service.js', () => ({
  listAgentUISurfaces: mocks.listAgentUISurfaces,
}));
vi.mock('../remote-chat.service.js', () => ({
  getRemoteChat: mocks.getRemoteChat,
  listRemoteChats: mocks.listRemoteChats,
}));
vi.mock('../surfaces/index.js', () => ({ getMainSurfaceHandler: () => undefined }));
vi.mock('../share-bundle.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../share-bundle.service.js')>();
  return {
    ...actual,
    buildArtifactShare: vi.fn(async () => ({
      title: 'Artifact',
      version: 1,
      kind: 'artifact:markdown',
      mediaType: 'text/markdown',
      text: 'Artifact contents',
      binary: null,
      interactive: false,
      includes: [],
      availableOptions: { includeComments: false, includeFullDiff: false },
    })),
  };
});

import {
  MAX_THREAD_SHARE_BYTES,
  buildThreadShare,
  projectRemoteTurns,
  projectThreadMessages,
} from '../thread-share.service.js';

const thread = (): ChatThread => ({
  id: 'thread-1',
  personaId: 'codex',
  title: 'Thread title',
  workspaceId: 'workspace-1',
  repoIds: [],
  createdAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-25T10:00:00.000Z',
  messageCount: 2,
  attentionState: 'idle',
  providerThreadId: 'PRIVATE-PROVIDER-HANDLE',
  workItemId: 'ANV-1',
  workItemProvider: 'linear',
});

let testDir: string;
function attachment(name: string, mimeType: string, path: string, size: number): ChatAttachment {
  return {
    id: name,
    name,
    mimeType,
    path,
    size,
    kind: 'file',
    createdAt: '2026-10-25T10:00:00.000Z',
  };
}

function localTarget() {
  return { itemType: 'thread' as const, itemId: 'thread-1' };
}

describe('thread-share.service', () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mezair-thread-share-'));
    mocks.thread = thread();
    mocks.messages = [
      {
        id: 'm-user',
        role: 'user',
        content: 'Hello',
        timestamp: '2026-10-25T10:00:00.000Z',
        sessionId: 'PRIVATE-SESSION-ID',
      },
      {
        id: 'm-assistant',
        role: 'assistant',
        content: 'Hi there',
        timestamp: '2026-10-25T10:01:00.000Z',
      },
    ];
    mocks.remoteChats = [];
    mocks.artifacts = [
      {
        id: 'artifact-1',
        title: 'Notes',
        kind: 'markdown',
        content: 'hidden',
        filePath: null,
        version: 1,
      },
    ];
    mocks.surfaces = [];
    mocks.getChatThread.mockReset().mockImplementation(() => mocks.thread);
    mocks.loadChatHistory.mockReset().mockImplementation(() => mocks.messages);
    mocks.listAgentUISurfaces.mockReset().mockImplementation(() => mocks.surfaces);
    mocks.getRemoteChat
      .mockReset()
      .mockImplementation((id: string) => mocks.remoteChats.find((chat) => chat.id === id));
    mocks.listRemoteChats
      .mockReset()
      .mockImplementation((workspaceId: string) =>
        mocks.remoteChats.filter((chat) => chat.workspaceId === workspaceId),
      );
  });

  afterEach(() => rmSync(testDir, { recursive: true, force: true }));

  it('projects visible local messages only and excludes system and provider-internal events', () => {
    const entries = projectThreadMessages([
      ...mocks.messages,
      {
        id: 'progress',
        role: 'system',
        content: 'PRIVATE EVENT WRAPPER',
        event: { type: 'text', text: 'Checking the affected code', assistantPhase: 'progress' },
        timestamp: '2026-10-25T10:01:30.000Z',
      },
      {
        id: 'system',
        role: 'system',
        content: 'PRIVATE SYSTEM PROMPT',
        timestamp: '2026-10-25T10:02:00.000Z',
      },
      {
        id: 'tool',
        role: 'assistant',
        content: 'PRIVATE TOOL PAYLOAD',
        timestamp: '2026-10-25T10:03:00.000Z',
        event: { type: 'tool_call' } as ChatMessage['event'],
      },
      {
        id: 'empty',
        role: 'assistant',
        content: '  ',
        timestamp: '2026-10-25T10:04:00.000Z',
      },
    ]);
    expect(entries.map((entry) => entry.text)).toEqual([
      'Hello',
      'Hi there',
      'Checking the affected code',
    ]);
    expect(entries[2].role).toBe('assistant');
    expect(JSON.stringify(entries)).not.toContain('PRIVATE');
  });

  it('marks truncated and unavailable Mesh responses in the transcript projection', () => {
    const entries = projectRemoteTurns({
      id: 'remote-1',
      workspaceId: 'workspace-1',
      targetEnrollmentId: 'device-1',
      provider: 'codex',
      model: 'model',
      permissionMode: 'read-only',
      state: 'completed',
      createdAt: '2026-10-25T10:00:00.000Z',
      updatedAt: '2026-10-25T10:01:00.000Z',
      turns: [
        {
          id: 'turn-1',
          prompt: 'First prompt',
          response: 'Partial response',
          responseTruncated: true,
          state: 'completed',
          createdAt: '2026-10-25T10:00:00.000Z',
        },
        {
          id: 'turn-2',
          prompt: 'Second prompt',
          state: 'failed',
          createdAt: '2026-10-25T10:02:00.000Z',
        },
      ],
    });
    expect(entries[1]).toMatchObject({
      text: 'Partial response',
      note: 'The host truncated this response.',
    });
    expect(entries[3]).toMatchObject({
      text: '',
      note: 'Response unavailable in this snapshot (failed).',
    });
  });

  it('builds a static snapshot from local and remote sources without private metadata', async () => {
    mocks.remoteChats = [
      {
        id: 'remote-1',
        workspaceId: 'workspace-1',
        sourceThreadId: 'thread-1',
        targetEnrollmentId: 'device-1',
        provider: 'codex',
        model: 'model',
        permissionMode: 'read-only',
        state: 'completed',
        sourceSessionId: 'PRIVATE-REMOTE-SESSION',
        createdAt: '2026-10-25T10:00:00.000Z',
        updatedAt: '2026-10-25T10:02:00.000Z',
        turns: [
          {
            id: 'turn-1',
            prompt: 'Remote prompt',
            response: 'Remote answer',
            state: 'completed',
            createdAt: '2026-10-25T10:02:00.000Z',
          },
        ],
      },
    ];
    const built = await buildThreadShare(localTarget(), {});
    const bundle = JSON.parse(built.text!) as {
      snapshot: { html: string };
      interactive?: unknown;
      files?: unknown[];
      continuation: ThreadContinuation;
    };
    expect(bundle.snapshot.html).toContain('Hello');
    expect(bundle.snapshot.html).toContain('Remote prompt');
    expect(bundle.snapshot.html).toContain('Remote answer');
    expect(bundle.snapshot.html).toContain('ANV-1');
    expect(bundle.snapshot.html).not.toContain('PRIVATE-PROVIDER-HANDLE');
    expect(bundle.snapshot.html).not.toContain('PRIVATE-SESSION-ID');
    expect(bundle.snapshot.html).not.toContain('PRIVATE-REMOTE-SESSION');
    expect(bundle.continuation.entries.map((entry) => entry.text)).toEqual([
      'Hello',
      'Hi there',
      'Remote prompt',
      'Remote answer',
    ]);
    expect(bundle.continuation.context.ticket).toEqual({ id: 'ANV-1', provider: 'linear' });
    expect(JSON.stringify(bundle.continuation)).not.toContain('PRIVATE');
    expect(bundle.continuation.items).toEqual([]);
    expect(bundle).not.toHaveProperty('interactive');
    expect(built.interactive).toBe(false);
    expect(built.kind).toBe('thread');
  });

  it('requires explicit context selections to belong to the source thread', async () => {
    await expect(
      buildThreadShare(localTarget(), { contextItemIds: ['artifact:foreign'] }),
    ).rejects.toThrow('Select up to 16 context items belonging to this thread.');
  });

  it('keeps selected text attachments as plaintext for secret scanning, not base64 files', async () => {
    const path = join(testDir, 'notes.txt');
    const secret = 'sk-live-thread-secret-12345';
    writeFileSync(path, `Notes include ${secret}`);
    const file = attachment(
      'attachment-1',
      'text/plain',
      path,
      Buffer.byteLength(`Notes include ${secret}`),
    );
    mocks.messages[0] = { ...mocks.messages[0], attachments: [file] };
    const built = await buildThreadShare(localTarget(), {
      contextItemIds: ['attachment:attachment-1'],
    });
    const bundle = JSON.parse(built.text!) as {
      snapshot: { html: string };
      files?: unknown[];
      continuation: ThreadContinuation;
    };
    expect(bundle.snapshot.html).toContain(secret);
    expect(bundle.files).toBeUndefined();
    expect(bundle.continuation.items).toEqual([
      { kind: 'attachment', title: 'attachment-1', text: `Notes include ${secret}` },
    ]);
  });

  it('enforces attachment and rendered snapshot size bounds', async () => {
    const oversizedPath = join(testDir, 'oversized.bin');
    writeFileSync(oversizedPath, '');
    truncateSync(oversizedPath, 8 * 1024 * 1024 + 1);
    const oversized = attachment(
      'attachment-big',
      'application/octet-stream',
      oversizedPath,
      8 * 1024 * 1024 + 1,
    );
    mocks.messages[0] = { ...mocks.messages[0], attachments: [oversized] };
    await expect(
      buildThreadShare(localTarget(), { contextItemIds: ['attachment:attachment-big'] }),
    ).rejects.toThrow('A selected file is unavailable or larger than 8 MB.');

    mocks.messages = [
      {
        id: 'large-message',
        role: 'user',
        content: 'x'.repeat(4 * 1024 * 1024),
        timestamp: '2026-10-25T10:00:00.000Z',
      },
    ];
    await expect(buildThreadShare(localTarget(), {})).rejects.toThrow(
      'This snapshot exceeds 4 MB of text.',
    );

    const binaryPath = join(testDir, 'near-limit.bin');
    writeFileSync(binaryPath, '');
    truncateSync(binaryPath, 8 * 1024 * 1024);
    const textPath = join(testDir, 'near-limit.txt');
    const text = 'y'.repeat(1_500_000);
    writeFileSync(textPath, text);
    mocks.messages = [
      {
        id: 'size-bound',
        role: 'user',
        content: 'See the selected files.',
        timestamp: '2026-10-25T10:00:00.000Z',
        attachments: [
          attachment('binary-limit', 'application/octet-stream', binaryPath, 8 * 1024 * 1024),
          attachment('text-limit', 'text/plain', textPath, Buffer.byteLength(text)),
        ],
      },
    ];
    await expect(
      buildThreadShare(localTarget(), {
        contextItemIds: ['attachment:binary-limit', 'attachment:text-limit'],
      }),
    ).rejects.toThrow('This share exceeds 12 MB.');
    expect(MAX_THREAD_SHARE_BYTES).toBe(12 * 1024 * 1024);
  });
});

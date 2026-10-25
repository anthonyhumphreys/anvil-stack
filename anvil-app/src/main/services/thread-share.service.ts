import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { ChatAttachment, ChatMessage, ChatThread } from '../../shared/types.js';
import type { RemoteChatRecord } from '../../shared/remote-chat.js';
import type {
  AnvilShareBundle,
  ShareContextItem,
  ShareOptionsInput,
  ShareTarget,
} from '../../shared/shares-ipc.js';
import { SHARE_BUNDLE_MEDIA_TYPE } from '../../shared/shares-ipc.js';
import {
  validateThreadContinuation,
  type ThreadContinuation,
} from '../../../cloud/contract/thread-pickup.js';
import { getDb } from '../db/database.js';
import { getChatThread, loadChatHistory } from './chat-persistence.service.js';
import { listAgentUISurfaces } from './agent-ui-intent.service.js';
import {
  buildArtifactShare,
  buildSurfaceShare,
  escapeHtml,
  htmlToText,
  SNAPSHOT_BASE_CSS,
  stripScripts,
  type ArtifactShareSource,
  type BuiltShare,
} from './share-bundle.service.js';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_THREAD_SHARE_BYTES = 12 * 1024 * 1024;
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const MAX_CONTEXT_ITEMS = 16;

interface TranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
  at: string;
  source: 'Conversation' | 'Mesh';
  note?: string;
}

/** Only visible conversation text. Provider events, system prompts and runtime handles stay local. */
export function projectThreadMessages(messages: ChatMessage[]): TranscriptEntry[] {
  return messages.flatMap((message): TranscriptEntry[] => {
    // Visible progress text is persisted with role:system as well as role:assistant.
    if (message.role !== 'user' && message.event?.type === 'text') {
      const text = message.event.text ?? message.content;
      return text.trim()
        ? [{ role: 'assistant', text, at: message.timestamp, source: 'Conversation' }]
        : [];
    }
    if (message.role !== 'user' && message.role !== 'assistant') return [];
    if (message.role === 'assistant' && message.event) return [];
    if (!message.content.trim()) return [];
    return [
      { role: message.role, text: message.content, at: message.timestamp, source: 'Conversation' },
    ];
  });
}

export function projectRemoteTurns(chat: RemoteChatRecord): TranscriptEntry[] {
  return chat.turns.flatMap((turn): TranscriptEntry[] => [
    { role: 'user', text: turn.prompt, at: turn.createdAt, source: 'Mesh' },
    {
      role: 'assistant',
      text: turn.response ?? '',
      at: turn.createdAt,
      source: 'Mesh',
      ...(turn.responseTruncated
        ? { note: 'The host truncated this response.' }
        : !turn.response
          ? { note: `Response unavailable in this snapshot (${turn.state}).` }
          : {}),
    },
  ]);
}

async function sourceFor(target: ShareTarget) {
  const { getRemoteChat, listRemoteChats } = await import('./remote-chat.service.js');
  let thread: ChatThread | null;
  let remotes: RemoteChatRecord[];
  if (target.itemType === 'remote-thread') {
    const remote = getRemoteChat(target.itemId);
    if (!remote) throw new Error('This Mesh thread is unavailable in the current account.');
    thread = remote.sourceThreadId ? getChatThread(remote.sourceThreadId) : null;
    if (thread && thread.workspaceId !== remote.workspaceId)
      throw new Error('The Mesh thread context belongs to another workspace.');
    remotes = [remote];
  } else {
    thread = getChatThread(target.itemId);
    if (!thread || thread.temporary) throw new Error('Save this thread before sharing it.');
    remotes = listRemoteChats(thread.workspaceId).filter(
      (chat) => chat.sourceThreadId === thread!.id,
    );
  }
  const messages = thread ? loadChatHistory(thread.id) : [];
  const entries = [...projectThreadMessages(messages), ...remotes.flatMap(projectRemoteTurns)].sort(
    (a, b) => a.at.localeCompare(b.at),
  );
  return { thread, remotes, messages, entries };
}

export async function threadShareInfo(target: ShareTarget) {
  if (target.itemType === 'remote-thread') {
    const { getRemoteChat } = await import('./remote-chat.service.js');
    const remote = getRemoteChat(target.itemId);
    if (!remote) throw new Error('This Mesh thread is unavailable in the current account.');
    return { workspaceId: remote.workspaceId };
  }
  const thread = getChatThread(target.itemId);
  if (!thread) throw new Error('This thread is no longer available.');
  return { workspaceId: thread.workspaceId };
}

function fileBytes(path: string): Buffer {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error();
    const bytes = readFileSync(path);
    if (bytes.byteLength > MAX_FILE_BYTES) throw new Error();
    return bytes;
  } catch {
    throw new Error(
      'A selected file is unavailable or larger than 8 MB. Deselect it and preview again.',
    );
  }
}

function isText(mediaType: string) {
  return (
    mediaType.startsWith('text/') ||
    ['application/json', 'application/xml', 'application/yaml', 'application/sql'].includes(
      mediaType,
    )
  );
}

export async function buildThreadShare(
  target: ShareTarget,
  options: ShareOptionsInput,
): Promise<
  BuiltShare & {
    contextItems: ShareContextItem[];
    suggestedTicket?: { id: string; provider: NonNullable<ChatThread['workItemProvider']> };
  }
> {
  const { thread, remotes, messages, entries } = await sourceFor(target);
  const title = thread?.title ?? remotes[0]?.turns[0]?.prompt.slice(0, 120) ?? 'Mesh conversation';
  const contextItems: ShareContextItem[] = [];
  const artifacts = thread
    ? (getDb()
        .prepare(
          'SELECT id, title, kind, content, file_path AS filePath, version FROM chat_artifacts WHERE thread_id = ? ORDER BY created_at, id',
        )
        .all(thread.id) as ArtifactShareSource[])
    : [];
  const { getMainSurfaceHandler } = await import('../surfaces/index.js');
  const surfaces = thread
    ? listAgentUISurfaces(thread.id).filter(
        (intent) =>
          intent.payload.surfaceKind !== 'artifact' &&
          !!getMainSurfaceHandler(intent.payload.surfaceKind)?.share,
      )
    : [];
  const attachments = new Map<string, ChatAttachment>();
  for (const message of messages)
    for (const attachment of message.attachments ?? []) attachments.set(attachment.id, attachment);
  for (const artifact of artifacts)
    contextItems.push({ id: `artifact:${artifact.id}`, kind: 'artifact', title: artifact.title });
  for (const surface of surfaces)
    contextItems.push({
      id: `surface:${surface.id}`,
      kind: 'surface',
      title: surface.payload.title,
    });
  for (const attachment of attachments.values())
    contextItems.push({
      id: `attachment:${attachment.id}`,
      kind: 'attachment',
      title: basename(attachment.name),
    });
  const selected = new Set(options.contextItemIds ?? []);
  if (
    selected.size > MAX_CONTEXT_ITEMS ||
    [...selected].some((id) => !contextItems.some((item) => item.id === id))
  ) {
    throw new Error('Select up to 16 context items belonging to this thread.');
  }
  const repoNames = (thread?.repoIds ?? []).flatMap((id) => {
    const repo = getDb().prepare('SELECT name FROM repos WHERE id = ?').get(id) as
      { name: string } | undefined;
    return repo ? [repo.name] : [];
  });
  const textBlock = (heading: string, text: string) =>
    `<section><h2>${escapeHtml(heading)}</h2><pre>${escapeHtml(text)}</pre></section>`;
  const continuation: ThreadContinuation = {
    format: 'anvil-thread-continuation/v1',
    entries,
    context: {
      repoNames,
      ...(thread?.workItemId && thread.workItemProvider
        ? {
            ticket: {
              id: thread.workItemId,
              provider: thread.workItemProvider,
              ...(thread.workItemTitle ? { title: thread.workItemTitle } : {}),
            },
          }
        : {}),
      ...(thread?.activeGoal
        ? { goal: `${thread.activeGoal.objective} (${thread.activeGoal.status})` }
        : {}),
      ...(thread?.activePlan
        ? { plan: thread.activePlan.steps.map((step) => `${step.status}: ${step.step}`).join('\n') }
        : {}),
    },
    items: [],
  };
  const html = [
    `<h1>${escapeHtml(title)}</h1><p class="anvil-note">Read-only snapshot. Later messages appear only when the author updates this link.</p>`,
    ...(thread?.workItemId
      ? [textBlock('Ticket', `${thread.workItemId}: ${thread.workItemTitle ?? ''}`)]
      : []),
    ...(repoNames.length ? [textBlock('Repositories', repoNames.join(', '))] : []),
    ...(thread?.activeGoal
      ? [textBlock('Goal', `${thread.activeGoal.objective} (${thread.activeGoal.status})`)]
      : []),
    ...(thread?.activePlan
      ? [
          textBlock(
            'Plan',
            thread.activePlan.steps.map((step) => `${step.status}: ${step.step}`).join('\n'),
          ),
        ]
      : []),
    '<h2>Conversation</h2>',
    ...entries.map(
      (entry) =>
        `<article><h3>${entry.role === 'user' ? 'You' : 'Assistant'} · ${escapeHtml(entry.source)}</h3><time>${entry.source === 'Mesh' ? 'Turn started ' : ''}${escapeHtml(entry.at)}</time><pre>${escapeHtml(entry.text)}</pre>${entry.note ? `<p class="anvil-note">${escapeHtml(entry.note)}</p>` : ''}</article>`,
    ),
  ];
  if (!entries.length) html.push('<p>No conversation messages have been recorded yet.</p>');
  const files: NonNullable<AnvilShareBundle['files']> = [];
  let fileTotal = 0;
  let css = SNAPSHOT_BASE_CSS;
  const addFile = (name: string, mediaType: string, bytes: Uint8Array) => {
    fileTotal += bytes.byteLength;
    if (fileTotal > MAX_FILE_BYTES)
      throw new Error('Selected files exceed 8 MB. Deselect files and preview again.');
    const safeName =
      Array.from(basename(name), (char) =>
        char.charCodeAt(0) < 32 || char === '\\' || char === '/' ? '_' : char,
      )
        .join('')
        .slice(0, 160) || 'attachment';
    files.push({ name: safeName, mediaType, dataBase64: Buffer.from(bytes).toString('base64') });
    html.push(
      `<p>Attached file: ${escapeHtml(safeName)} (${bytes.byteLength} bytes; not scanned for secrets)</p>`,
    );
    return files.length - 1;
  };
  for (const artifact of artifacts.filter((item) => selected.has(`artifact:${item.id}`))) {
    if (artifact.filePath) fileBytes(artifact.filePath); // Check limits before the existing builder reads.
    const built = await buildArtifactShare(artifact, options);
    if (built.binary)
      continuation.items.push({
        kind: 'artifact',
        title: artifact.title,
        fileIndex: addFile(artifact.title, built.mediaType, built.binary),
      });
    else if (built.mediaType === SHARE_BUNDLE_MEDIA_TYPE && built.text) {
      const bundle = JSON.parse(built.text) as AnvilShareBundle;
      html.push(
        `<section><h2>${escapeHtml(artifact.title)}</h2>${stripScripts(bundle.snapshot.html)}</section>`,
      );
      css += `\n${bundle.snapshot.css}`;
      continuation.items.push({
        kind: 'artifact',
        title: artifact.title,
        text: htmlToText(bundle.snapshot.html),
      });
    } else {
      html.push(textBlock(artifact.title, built.text ?? ''));
      continuation.items.push({ kind: 'artifact', title: artifact.title, text: built.text ?? '' });
    }
  }
  for (const intent of surfaces.filter((item) => selected.has(`surface:${item.id}`))) {
    const built = buildSurfaceShare(
      {
        id: intent.id,
        title: intent.payload.title,
        surfaceKind: intent.payload.surfaceKind,
        revision: intent.revision,
        digest: intent.payload.digest,
        data: intent.payload.data,
      },
      getMainSurfaceHandler(intent.payload.surfaceKind),
      options,
    );
    const bundle = JSON.parse(built.text!) as AnvilShareBundle;
    const snapshot = bundle.snapshot.html.replace(
      /anvil-image:([A-Za-z0-9_-]+)/g,
      (_match, key: string) => {
        const image = bundle.snapshot.images?.[key];
        return image && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(image)
          ? image
          : '';
      },
    );
    html.push(
      `<section><h2>${escapeHtml(intent.payload.title)}</h2>${stripScripts(snapshot)}</section>`,
    );
    css += `\n${bundle.snapshot.css}`;
    continuation.items.push({
      kind: 'surface',
      title: intent.payload.title,
      text: htmlToText(snapshot),
    });
  }
  for (const attachment of attachments.values()) {
    if (!selected.has(`attachment:${attachment.id}`)) continue;
    const bytes = fileBytes(attachment.path);
    if (isText(attachment.mimeType)) {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      html.push(textBlock(basename(attachment.name), text));
      continuation.items.push({ kind: 'attachment', title: basename(attachment.name), text });
    } else
      continuation.items.push({
        kind: 'attachment',
        title: basename(attachment.name),
        fileIndex: addFile(attachment.name, attachment.mimeType, bytes),
      });
  }
  const snapshot = { html: html.join('\n'), css };
  if (Buffer.byteLength(snapshot.html) + Buffer.byteLength(css) > MAX_HTML_BYTES)
    throw new Error('This snapshot exceeds 4 MB of text. Select less supporting context.');
  // Each explicitly reviewed snapshot gets the next published version.
  const last = getDb()
    .prepare('SELECT MAX(version) AS version FROM shares WHERE item_type = ? AND item_id = ?')
    .get(target.itemType, target.itemId) as { version: number | null };
  const version = (last.version ?? 0) + 1;
  const bundle: AnvilShareBundle = {
    format: 'anvil-share/v1',
    schemaVersion: 1,
    kind: 'thread',
    title,
    version,
    sharedAt: new Date().toISOString(),
    digest: `${entries.length} conversation entries · ${selected.size} context items`,
    snapshot,
    continuation: validateThreadContinuation(continuation, files.length),
    ...(files.length ? { files } : {}),
  };
  const text = JSON.stringify(bundle);
  if (Buffer.byteLength(text) > MAX_THREAD_SHARE_BYTES)
    throw new Error('This share exceeds 12 MB. Select less supporting context.');
  return {
    title,
    version,
    text,
    mediaType: SHARE_BUNDLE_MEDIA_TYPE,
    kind: 'thread',
    interactive: false,
    binary: null,
    includes: [
      'Conversation, ticket reference, repository names and current plan/goal',
      ...contextItems.filter((item) => selected.has(item.id)).map((item) => item.title),
      ...(files.length ? ['Selected binary files cannot be scanned for secrets'] : []),
    ],
    availableOptions: {
      includeComments: surfaces.length > 0,
      includeFullDiff: surfaces.some((intent) => intent.payload.surfaceKind === 'review'),
    },
    contextItems,
    ...(thread?.workItemId && thread.workItemProvider
      ? { suggestedTicket: { id: thread.workItemId, provider: thread.workItemProvider } }
      : {}),
  };
}

import { shell } from 'electron';
import type { ChatArtifact, ChatArtifactKind } from '../../../shared/types.js';
import type { AgentUISurfaceIntent } from '../../../shared/agent-ui-intents.js';
import {
  ARTIFACT_KINDS,
  BINARY_ARTIFACT_KINDS,
  type ArtifactSurfacePayload,
} from '../../../shared/surfaces/kinds/artifact.js';
import {
  AgentToolError,
  textResult,
  type AgentToolSessionContext,
} from '../../agent-tools/dispatch.js';
import {
  dismissAgentUIIntent,
  listAgentUISurfaces,
} from '../../services/agent-ui-intent.service.js';
import { broadcastAgentUIIntent } from '../../services/codex-session.service.js';
import {
  discardChatArtifact,
  extensionForKind,
  getChatArtifact,
  getChatArtifactRevision,
  listChatArtifacts,
  saveChatArtifactToRepository,
  upsertChatArtifact,
} from '../../services/chat-artifact.service.js';
import { threadRepoId } from '../../services/chat-sketch.service.js';
import {
  combineToolProviders,
  createToolProvider,
  patchSurface,
  publishSurface,
  surfaceResult,
  surfaceToolProvider,
} from '../core.js';
import type { MainSurfaceHandler, SurfaceActionContext } from '../types.js';

const MAX_ARTIFACT_CONTENT_BYTES = 5_000_000;
const MAX_READ_CHARS = 400_000;
const ARTIFACT_ROOT_PREFIX = /^\.?\/?\.mezair\/artifacts\//;

/** Publishes the inline Artifact surface for the version a turn produced. */
export function publishArtifactSurface(
  ctx: AgentToolSessionContext,
  artifact: ChatArtifact,
  operation: ArtifactSurfacePayload['operation'],
): AgentUISurfaceIntent {
  return publishSurface<ArtifactSurfacePayload>(ctx, {
    surfaceKind: 'artifact',
    title: artifact.title,
    key: `artifact:${artifact.id}`,
    data: artifactPayload(artifact, operation),
  });
}

/** Repo for new repository artifacts: the thread's active repo when in scope, else the first session repo. */
export function resolveArtifactRepoId(ctx: AgentToolSessionContext): string | null {
  if (ctx.mode === 'read-only') return null;
  const threadRepo = ctx.appThreadId ? threadRepoId(ctx.appThreadId) : null;
  if (threadRepo && ctx.repoIds.includes(threadRepo)) return threadRepo;
  return ctx.repoIds[0] ?? null;
}

function artifactPayload(
  artifact: ChatArtifact,
  operation: ArtifactSurfacePayload['operation'],
): ArtifactSurfacePayload {
  return {
    artifactId: artifact.id,
    version: artifact.version,
    operation,
    title: artifact.title.slice(0, 300),
    kind: artifact.kind,
    storage: artifact.storage,
    relativePath: artifact.relativePath.slice(0, 1000),
  };
}

function requireArtifactInScope(ctx: AgentToolSessionContext, artifactId: unknown): ChatArtifact {
  const artifact = typeof artifactId === 'string' ? getChatArtifact(artifactId) : null;
  if (!artifact) throw new AgentToolError(`Artifact not found: ${String(artifactId)}`, 'not-found');
  if (artifact.threadId !== ctx.appThreadId) {
    throw new AgentToolError('Artifact belongs to another thread.', 'forbidden');
  }
  return artifact;
}

function assertContentSize(content: string): void {
  if (Buffer.byteLength(content, 'utf8') > MAX_ARTIFACT_CONTENT_BYTES) {
    throw new AgentToolError('Artifact content is too large (5 MB maximum).', 'invalid-params');
  }
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'artifact'
  );
}

function uniquePath(threadId: string, preferred: string): string {
  const taken = new Set(listChatArtifacts(threadId).map((artifact) => artifact.relativePath));
  if (!taken.has(preferred)) return preferred;
  const dot = preferred.lastIndexOf('.');
  const stem = dot > 0 ? preferred.slice(0, dot) : preferred;
  const extension = dot > 0 ? preferred.slice(dot) : '';
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${stem}-${index}${extension}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem}-${Date.now()}${extension}`;
}

function wrapServiceError(error: unknown): never {
  if (error instanceof AgentToolError) throw error;
  throw new AgentToolError(
    error instanceof Error ? error.message : String(error),
    'invalid-params',
  );
}

const artifactToolProvider = createToolProvider('artifact', [
  {
    tool: {
      name: 'artifact_create',
      title: 'Create artifact',
      description:
        'Create a durable, versioned document (runbook, spec, plan, report, HTML page, diagram source…) the user will come back to, edit, hand over or commit. Shows inline and in the Library. Returns {artifactId, version} and a digest, not the content. For binary docx/pptx/pdf/xlsx, write the file under .mezair/artifacts first and pass filePath.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          kind: { type: 'string', enum: ARTIFACT_KINDS },
          path: {
            type: 'string',
            maxLength: 500,
            description: 'Path under .mezair/artifacts, e.g. "runbooks/db-migration.md".',
          },
          storage: {
            type: 'string',
            enum: ['repository', 'session'],
            description: 'repository (default when a repo is attached) or session-only.',
          },
          content: { type: 'string' },
          filePath: {
            type: 'string',
            maxLength: 500,
            description: 'Existing file under .mezair/artifacts (binary kinds).',
          },
        },
        required: ['title', 'kind'],
        additionalProperties: false,
      },
    },
    handler: (ctx, args) => {
      const threadId = ctx.appThreadId as string;
      const kind = args.kind as ChatArtifactKind;
      const content = typeof args.content === 'string' ? args.content : undefined;
      const filePath =
        typeof args.filePath === 'string' && args.filePath.trim()
          ? args.filePath.trim().replace(ARTIFACT_ROOT_PREFIX, '')
          : undefined;
      if ((content === undefined) === (filePath === undefined)) {
        throw new AgentToolError('Pass exactly one of content or filePath.', 'invalid-params');
      }
      if (content !== undefined) assertContentSize(content);
      if (content !== undefined && !content.trim()) {
        throw new AgentToolError('Artifact content is empty.', 'invalid-params');
      }
      if (content !== undefined && BINARY_ARTIFACT_KINDS.includes(kind)) {
        throw new AgentToolError(
          `${kind} artifacts must reference a file via filePath; do not inline binary data.`,
          'invalid-params',
        );
      }
      const repoId = resolveArtifactRepoId(ctx);
      const storage = args.storage === 'session' || !repoId ? 'session' : 'repository';
      if (filePath && storage === 'session') {
        throw new AgentToolError(
          'File-backed artifacts need repository storage and an attached repository.',
          'invalid-params',
        );
      }
      const explicitPath =
        typeof args.path === 'string' && args.path.trim()
          ? args.path.trim().replace(ARTIFACT_ROOT_PREFIX, '')
          : undefined;
      const requestedPath = filePath ?? explicitPath;
      if (
        requestedPath &&
        listChatArtifacts(threadId).some((artifact) => artifact.relativePath === requestedPath)
      ) {
        throw new AgentToolError(
          `An artifact already exists at ${requestedPath}; use artifact_update.`,
          'conflict',
        );
      }
      let artifact: ChatArtifact;
      try {
        artifact = upsertChatArtifact({
          threadId,
          repoId: storage === 'repository' ? repoId : null,
          title: String(args.title),
          kind,
          storage,
          relativePath:
            requestedPath ??
            uniquePath(threadId, `${slugify(String(args.title))}.${extensionForKind(kind)}`),
          content: content ?? `File artifact: ${filePath}`,
          contentEncoding: filePath ? 'file' : 'utf8',
          status: 'draft',
          visibility: 'local',
          source: 'assistant',
        });
      } catch (error) {
        wrapServiceError(error);
      }
      const intent = publishArtifactSurface(ctx, artifact, 'created');
      return surfaceResult(intent, { artifactId: artifact.id, version: artifact.version });
    },
  },
  {
    tool: {
      name: 'artifact_update',
      title: 'Update artifact',
      description:
        'Replace an artifact’s content as a new version. baseVersion must be the version you last saw; a stale version is rejected so you never overwrite the user’s edits. Returns the new version and a digest.',
      inputSchema: {
        type: 'object',
        properties: {
          artifactId: { type: 'string', minLength: 1 },
          baseVersion: { type: 'integer', minimum: 1 },
          content: { type: 'string' },
          title: { type: 'string', minLength: 1, maxLength: 200 },
        },
        required: ['artifactId', 'baseVersion', 'content'],
        additionalProperties: false,
      },
    },
    handler: (ctx, args) => {
      const current = requireArtifactInScope(ctx, args.artifactId);
      if (Number(args.baseVersion) !== current.version) {
        throw new AgentToolError(
          `Artifact version ${String(args.baseVersion)} is stale; current version is ${current.version}. Read it again with artifact_read before updating.`,
          'conflict',
        );
      }
      const content = String(args.content);
      assertContentSize(content);
      if (!content.trim()) throw new AgentToolError('Artifact content is empty.', 'invalid-params');
      const fileBacked = BINARY_ARTIFACT_KINDS.includes(current.kind) && Boolean(current.filePath);
      let artifact: ChatArtifact;
      try {
        artifact = upsertChatArtifact({
          threadId: current.threadId,
          repoId: current.repoId ?? null,
          title: typeof args.title === 'string' ? args.title : current.title,
          kind: current.kind,
          storage: current.storage,
          relativePath: current.relativePath,
          content,
          contentEncoding: fileBacked ? 'file' : 'utf8',
          status: current.status,
          visibility: current.visibility,
          source: 'assistant',
        });
      } catch (error) {
        wrapServiceError(error);
      }
      const intent = publishArtifactSurface(ctx, artifact, 'updated');
      return surfaceResult(intent, { artifactId: artifact.id, version: artifact.version });
    },
  },
  {
    tool: {
      name: 'artifact_read',
      title: 'Read artifact',
      description: 'Read an artifact’s content (latest version, or a specific earlier version).',
      inputSchema: {
        type: 'object',
        properties: {
          artifactId: { type: 'string', minLength: 1 },
          version: { type: 'integer', minimum: 1 },
        },
        required: ['artifactId'],
        additionalProperties: false,
      },
    },
    handler: (ctx, args) => {
      const artifact = requireArtifactInScope(ctx, args.artifactId);
      const requested = typeof args.version === 'number' ? args.version : artifact.version;
      const revision =
        requested === artifact.version
          ? { title: artifact.title, content: artifact.content, version: artifact.version }
          : getChatArtifactRevision(artifact.id, requested);
      if (!revision) {
        throw new AgentToolError(
          `Version ${requested} of this artifact is not stored.`,
          'not-found',
        );
      }
      const content =
        revision.content.length > MAX_READ_CHARS
          ? `${revision.content.slice(0, MAX_READ_CHARS)}\n… truncated (${revision.content.length} chars).`
          : revision.content;
      return textResult(
        `Artifact "${revision.title}" v${revision.version} of ${artifact.version} (${artifact.kind}, ${artifact.storage}: ${artifact.relativePath})\n\n${content}`,
        { artifactId: artifact.id, version: revision.version, latestVersion: artifact.version },
      );
    },
  },
  {
    tool: {
      name: 'artifact_list',
      title: 'List artifacts',
      description: 'List the artifacts in this thread (ids, titles, kinds, latest versions).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    handler: (ctx) => {
      const artifacts = listChatArtifacts(ctx.appThreadId as string);
      if (artifacts.length === 0)
        return textResult('No artifacts in this thread yet.', { artifacts: [] });
      return textResult(
        artifacts
          .map(
            (artifact) =>
              `- ${artifact.id}: "${artifact.title}" v${artifact.version} (${artifact.kind}, ${artifact.storage}: ${artifact.relativePath})`,
          )
          .join('\n'),
        {
          artifacts: artifacts.map(({ id, title, kind, version, storage, relativePath }) => ({
            id,
            title,
            kind,
            version,
            storage,
            relativePath,
          })),
        },
      );
    },
  },
]);

async function executeArtifactAction(
  ctx: SurfaceActionContext,
  request: { action: string },
): Promise<{ ok: boolean; message?: string; error?: string }> {
  const data = ctx.intent.payload.data as ArtifactSurfacePayload;
  const artifact = getChatArtifact(data.artifactId);
  if (!artifact) return { ok: false, error: 'This artifact no longer exists.' };
  switch (request.action) {
    case 'open_editor': {
      if (!artifact.filePath) {
        return {
          ok: false,
          error: 'Save this artifact to the repository to open it in an editor.',
        };
      }
      const failure = await shell.openPath(artifact.filePath);
      return failure ? { ok: false, error: failure } : { ok: true, message: artifact.relativePath };
    }
    case 'save_to_repo': {
      if (artifact.storage === 'repository')
        return { ok: true, message: 'Already in the repository.' };
      const repoId = threadRepoId(artifact.threadId);
      if (!repoId) return { ok: false, error: 'Attach a repository to this thread first.' };
      const saved = saveChatArtifactToRepository(artifact.id, repoId);
      refreshArtifactSurfaces(saved);
      return { ok: true, message: `Saved to .mezair/artifacts/${saved.relativePath}` };
    }
    case 'discard': {
      if (artifact.storage !== 'session') {
        return {
          ok: false,
          error: 'Repository artifacts are part of the repo; delete the file instead.',
        };
      }
      if (!discardChatArtifact(artifact.id))
        return { ok: false, error: 'Could not discard this artifact.' };
      for (const intent of listAgentUISurfaces(artifact.threadId, {
        surfaceKind: 'artifact',
        includeSuperseded: true,
      })) {
        if ((intent.payload.data as ArtifactSurfacePayload).artifactId !== artifact.id) continue;
        broadcastAgentUIIntent(dismissAgentUIIntent(intent.id), undefined);
      }
      return { ok: true, message: 'Artifact discarded.' };
    }
    default:
      return { ok: false, error: `Unknown action: ${request.action}.` };
  }
}

/** Patches the newest surface for an artifact after a user-side change (save to repo). */
function refreshArtifactSurfaces(artifact: ChatArtifact): void {
  const current = listAgentUISurfaces(artifact.threadId, { surfaceKind: 'artifact' }).filter(
    (intent) => (intent.payload.data as ArtifactSurfacePayload).artifactId === artifact.id,
  );
  for (const intent of current) {
    patchSurface<ArtifactSurfacePayload>(intent.id, undefined, () =>
      artifactPayload(artifact, 'updated'),
    );
  }
}

export const artifactSurfaceHandler: MainSurfaceHandler = {
  kind: 'artifact',
  // Also carries the generic surface_* / mezair_skill_get tools until they are registered separately.
  toolProvider: combineToolProviders('artifact', [artifactToolProvider, surfaceToolProvider]),
  executeAction: executeArtifactAction,
};

export { artifactToolProvider };

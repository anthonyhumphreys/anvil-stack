import type { AgentUIIntent, AgentUISurfaceIntent } from '../../../shared/agent-ui-intents';
import { AGENT_UI_PROTOCOL_VERSION } from '../../../shared/agent-ui-intents';
import { getSurfaceKind } from '../../../shared/surfaces/registry';
import type { ShareTarget } from '../../../shared/shares-ipc';
import type { ArtifactSurfaceData, SketchSurfaceData } from '../../../shared/surfaces/types';
import type { ChatArtifact } from '../../../shared/types';
import { newerIntent, shouldReplaceIntent } from '../../utils/intent-revision';

export { newerIntent, shouldReplaceIntent };

export const SURFACE_STAGE_PARAM = 'surface';
const SYNTHETIC_ARTIFACT_PREFIX = 'artifact:';

/**
 * Whether a declared action should be offered. Read-only threads hide every
 * `mutation` action (the host controller refuses them anyway); undeclared ids
 * are local view affordances and stay available.
 */
export function isActionAvailable(
  kind: string,
  action: string,
  readOnly: boolean | undefined,
): boolean {
  if (!readOnly) return true;
  return getSurfaceKind(kind)?.actions[action]?.semantics.type !== 'mutation';
}

/** `isActionAvailable` bound to one surface kind, for views that check several actions. */
export function actionAvailability(
  kind: string,
  readOnly: boolean | undefined,
): (action: string) => boolean {
  return (action) => isActionAvailable(kind, action, readOnly);
}

export function isSurfaceIntent(intent: AgentUIIntent | undefined): intent is AgentUISurfaceIntent {
  return intent?.kind === 'surface';
}

export function surfaceDomId(surfaceId: string): string {
  return `surface-${surfaceId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

export function readStageSurfaceId(search: URLSearchParams): string | null {
  const value = search.get(SURFACE_STAGE_PARAM)?.trim();
  return value ? value : null;
}

export function withStageSurface(
  search: URLSearchParams,
  surfaceId: string | null,
): URLSearchParams {
  const next = new URLSearchParams(search);
  if (surfaceId) next.set(SURFACE_STAGE_PARAM, surfaceId);
  else next.delete(SURFACE_STAGE_PARAM);
  return next;
}

/**
 * The surface that replaced this one: the explicit `supersededBy`, or the most
 * recent later surface publishing the same logical `key`.
 */
export function resolveSupersedingId(
  intent: AgentUISurfaceIntent,
  surfaces: readonly AgentUISurfaceIntent[],
): string | undefined {
  if (intent.payload.supersededBy) return intent.payload.supersededBy;
  const key = intent.payload.key;
  if (!key) return undefined;
  const created = Date.parse(intent.createdAt);
  let latest: AgentUISurfaceIntent | undefined;
  for (const candidate of surfaces) {
    if (candidate.id === intent.id || candidate.payload.key !== key) continue;
    if (Date.parse(candidate.createdAt) <= created) continue;
    if (!latest || Date.parse(candidate.createdAt) > Date.parse(latest.createdAt)) {
      latest = candidate;
    }
  }
  return latest?.id;
}

export function formatRelativeTime(iso: string, now = Date.now()): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(time).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** "v3 · updated 2m ago" — the shared chrome meta line. */
export function formatSurfaceMeta(intent: AgentUISurfaceIntent, now = Date.now()): string {
  const parts: string[] = [];
  if (intent.revision > 1) parts.push(`v${intent.revision}`);
  if (intent.payload.streaming) parts.push('Writing…');
  else {
    const relative = formatRelativeTime(intent.updatedAt, now);
    if (relative) parts.push(intent.revision > 1 ? `updated ${relative}` : relative);
  }
  return parts.join(' · ');
}

export function syntheticArtifactSurfaceId(artifactId: string): string {
  return `${SYNTHETIC_ARTIFACT_PREFIX}${artifactId}`;
}

/** Artifacts persisted from fences have no published surface; the stage synthesises one. */
export function isSyntheticSurfaceId(surfaceId: string): boolean {
  return surfaceId.startsWith(SYNTHETIC_ARTIFACT_PREFIX);
}

export function parseSyntheticArtifactSurfaceId(surfaceId: string): string | null {
  return isSyntheticSurfaceId(surfaceId)
    ? surfaceId.slice(SYNTHETIC_ARTIFACT_PREFIX.length) || null
    : null;
}

export function buildArtifactSurfaceIntent(artifact: ChatArtifact): AgentUISurfaceIntent {
  const data: ArtifactSurfaceData = {
    artifactId: artifact.id,
    version: artifact.version,
    operation: artifact.version > 1 ? 'updated' : 'created',
  };
  return {
    protocolVersion: AGENT_UI_PROTOCOL_VERSION,
    id: syntheticArtifactSurfaceId(artifact.id),
    kind: 'surface',
    revision: artifact.version,
    scope: { threadId: artifact.threadId },
    lifecycle: 'presented',
    presentation: { collapsed: false, hidden: false },
    payload: {
      surfaceKind: 'artifact',
      title: artifact.title,
      streaming: false,
      digest: `${artifact.title} (${artifact.kind}, v${artifact.version})`,
      data,
    },
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };
}

/** `?artifact=<id>` deep link (Library) — resolved to a stage surface once the thread loads. */
export const ARTIFACT_LINK_PARAM = 'artifact';

/**
 * Stage surface for an artifact deep link: the latest published artifact
 * surface for it, else the synthetic stage-only surface when the thread knows
 * the artifact (fence-persisted). Null while the owning thread isn't loaded.
 */
export function resolveArtifactStageSurfaceId(
  artifactId: string,
  surfaces: readonly AgentUISurfaceIntent[],
  artifacts: readonly Pick<ChatArtifact, 'id'>[],
): string | null {
  let latest: { id: string; version: number; createdAt: number } | undefined;
  for (const surface of surfaces) {
    if (surface.payload.surfaceKind !== 'artifact') continue;
    const data = readArtifactSurfaceData(surface.payload.data);
    if (data?.artifactId !== artifactId) continue;
    const createdAt = Date.parse(surface.createdAt) || 0;
    if (
      !latest ||
      data.version > latest.version ||
      (data.version === latest.version && createdAt >= latest.createdAt)
    ) {
      latest = { id: surface.id, version: data.version, createdAt };
    }
  }
  if (latest) return latest.id;
  return artifacts.some((artifact) => artifact.id === artifactId)
    ? syntheticArtifactSurfaceId(artifactId)
    : null;
}

export function readArtifactSurfaceData(data: unknown): ArtifactSurfaceData | null {
  if (!data || typeof data !== 'object') return null;
  const candidate = data as Partial<ArtifactSurfaceData>;
  if (typeof candidate.artifactId !== 'string' || !candidate.artifactId) return null;
  const version = Number(candidate.version);
  return {
    artifactId: candidate.artifactId,
    version: Number.isFinite(version) && version > 0 ? version : 1,
    operation: candidate.operation === 'updated' ? 'updated' : 'created',
  };
}

export function readSketchSurfaceData(data: unknown): SketchSurfaceData | null {
  if (!data || typeof data !== 'object') return null;
  const candidate = data as Partial<SketchSurfaceData>;
  if (typeof candidate.sketchId !== 'string' || !candidate.sketchId) return null;
  const height = Number(candidate.height);
  return {
    sketchId: candidate.sketchId,
    ...(Number.isFinite(height) && height > 0 ? { height } : {}),
  };
}

/**
 * What Share… publishes. Artifacts share the artifact; shareable kinds share
 * the surface; sketches are kept first (handled by the host) so return null.
 */
export function resolveShareTarget(
  intent: AgentUISurfaceIntent,
  kindShareable: boolean,
): ShareTarget | null {
  if (intent.payload.surfaceKind === 'artifact') {
    const data = readArtifactSurfaceData(intent.payload.data);
    return data ? { itemType: 'artifact', itemId: data.artifactId } : null;
  }
  if (intent.payload.surfaceKind === 'sketch') return null;
  if (kindShareable && !isSyntheticSurfaceId(intent.id)) {
    return { itemType: 'surface', itemId: intent.id };
  }
  return null;
}

export function canShareSurface(intent: AgentUISurfaceIntent, kindShareable: boolean): boolean {
  return (
    intent.payload.surfaceKind === 'sketch' || resolveShareTarget(intent, kindShareable) !== null
  );
}

export function isEmptySurfaceData(data: unknown): boolean {
  if (data === null || data === undefined) return true;
  if (Array.isArray(data)) return data.length === 0;
  if (typeof data === 'object') return Object.keys(data as object).length === 0;
  return false;
}

/** Human label for a normalised region anchor. */
export function describeRegion(rect: { x: number; y: number; width: number; height: number }) {
  const pct = (value: number) => `${Math.round(value * 100)}%`;
  return `Region at ${pct(rect.x)}, ${pct(rect.y)} (${pct(rect.width)} × ${pct(rect.height)})`;
}

/** Normalise a drag between two points inside a box into a 0..1 rectangle. */
export function normaliseRegion(
  start: { x: number; y: number },
  end: { x: number; y: number },
  box: { width: number; height: number },
): { x: number; y: number; width: number; height: number } | null {
  if (box.width <= 0 || box.height <= 0) return null;
  const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);
  const left = clamp(Math.min(start.x, end.x), box.width);
  const top = clamp(Math.min(start.y, end.y), box.height);
  const right = clamp(Math.max(start.x, end.x), box.width);
  const bottom = clamp(Math.max(start.y, end.y), box.height);
  if (right - left < 8 || bottom - top < 8) return null;
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return {
    x: round(left / box.width),
    y: round(top / box.height),
    width: round((right - left) / box.width),
    height: round((bottom - top) / box.height),
  };
}

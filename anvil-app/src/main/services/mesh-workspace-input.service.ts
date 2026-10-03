import { createHash } from 'node:crypto';
import type { ExecutionManifest } from '../../../cloud/contract/jobs.js';
import { SYNC_ENTITY_WORKSPACE_DEFINITION } from '../../shared/sync-mesh.js';
import { getDb } from '../db/database.js';
import {
  applyRemoteEntityPayload,
  buildEntityPayload,
  entityPayloadIssue,
  workspaceDefinitionRevision,
} from './sync-entity-domain.js';
import { canonicalJson } from './sync-persistence.service.js';

/** Portable task data only. Local checkout paths and account keys are excluded. */
export function remoteWorkspaceDefinition(workspaceId: string): unknown {
  const payload = buildEntityPayload(SYNC_ENTITY_WORKSPACE_DEFINITION, workspaceId);
  if (payload === null) throw new Error(`workspace not found: ${workspaceId}`);
  return payload;
}

/** Fresh cloud workers receive this definition through the task content key. */
export function installTaskWorkspaceDefinition(
  manifest: ExecutionManifest,
  isCloudWorker: boolean,
): void {
  if (!isCloudWorker || manifest.inputs['workspaceDefinition'] === undefined) return;
  const payload = manifest.inputs['workspaceDefinition'];
  const workspaceId = manifest.inputs['workspaceId'];
  if (
    typeof workspaceId !== 'string' ||
    entityPayloadIssue(SYNC_ENTITY_WORKSPACE_DEFINITION, payload) !== null ||
    typeof payload !== 'object' ||
    payload === null ||
    (payload as Record<string, unknown>)['id'] !== workspaceId
  ) {
    throw new Error('task-workspace-definition-invalid');
  }
  const digest = createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
  if (digest !== manifest.workspaceDefinitionRevision)
    throw new Error('task-workspace-definition-pin-mismatch');
  if (workspaceDefinitionRevision(workspaceId) === digest) return;
  getDb().transaction(() => {
    applyRemoteEntityPayload(SYNC_ENTITY_WORKSPACE_DEFINITION, workspaceId, payload);
    if (workspaceDefinitionRevision(workspaceId) !== digest)
      throw new Error('task-workspace-definition-did-not-converge');
  })();
}

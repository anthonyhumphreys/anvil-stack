import { getDb } from '../db/database.js';
import {
  constrainPermissionMode,
  isPermissionMode,
  type PermissionMode,
} from '../../../cloud/contract/permissions.js';

export function getMeshMaximumPermissionMode(): PermissionMode {
  const row = getDb()
    .prepare('SELECT max_permission_mode FROM mesh_worker_state WHERE id = 1')
    .get() as { max_permission_mode: string } | undefined;
  return isPermissionMode(row?.max_permission_mode) ? row.max_permission_mode : 'on-request';
}

export function requestedMeshPermissionMode(inputs: Record<string, unknown>): PermissionMode {
  if (inputs['permissionMode'] !== undefined) {
    if (!isPermissionMode(inputs['permissionMode'])) throw new Error('invalid-job-permission-mode');
    return inputs['permissionMode'];
  }
  // Older callers carry only the provider sandbox. Never infer unattended permission
  // from workspace-write, which also represents interactive approval mode.
  return inputs['sandbox'] === 'danger-full-access'
    ? 'full-access'
    : inputs['sandbox'] === 'read-only'
      ? 'read-only'
      : 'on-request';
}

export function effectiveMeshPermissionMode(inputs: Record<string, unknown>): PermissionMode {
  return constrainPermissionMode(
    requestedMeshPermissionMode(inputs),
    getMeshMaximumPermissionMode(),
  );
}

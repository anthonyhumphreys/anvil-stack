/** Shared running modes. A target's local ceiling always wins over a job request. */
export const PERMISSION_MODES = [
  'read-only',
  'on-request',
  'workspace-auto',
  'full-access',
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return PERMISSION_MODES.some((mode) => mode === value);
}

export function constrainPermissionMode(
  requested: PermissionMode,
  maximum: PermissionMode,
): PermissionMode {
  return PERMISSION_MODES[
    Math.min(PERMISSION_MODES.indexOf(requested), PERMISSION_MODES.indexOf(maximum))
  ]!;
}

export function permissionSandbox(
  mode: PermissionMode,
): 'read-only' | 'workspace-write' | 'danger-full-access' {
  return mode === 'full-access'
    ? 'danger-full-access'
    : mode === 'read-only'
      ? 'read-only'
      : 'workspace-write';
}

/** Transport pin excludes node-local policy; the target binds its own approval separately. */
export function bootstrapManifestPolicy() {
  return { worker: { allowJobs: true, allowedSources: ['same-account'], maxConcurrentJobs: 1 } };
}

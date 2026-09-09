/** Embedded at build time. Runtime environment variables cannot select a preview profile. */
export interface PreviewBuildIdentity {
  buildId: string;
  headSha: string;
  pullRequestNumber: number;
  platform: 'darwin';
  arch: 'arm64' | 'x64';
}

export function parsePreviewBuild(value: string | undefined): PreviewBuildIdentity | null {
  if (!value) return null;
  const data: unknown = JSON.parse(value);
  if (!data || typeof data !== 'object') throw new Error('Invalid preview build identity');
  const identity = data as PreviewBuildIdentity;
  if (
    !Number.isSafeInteger(identity.pullRequestNumber) ||
    identity.pullRequestNumber <= 0 ||
    !/^[a-f0-9]{40}$/.test(identity.headSha) ||
    identity.platform !== 'darwin' ||
    !['arm64', 'x64'].includes(identity.arch) ||
    !new RegExp(
      `^pr-${identity.pullRequestNumber}-${identity.headSha}-darwin-${identity.arch}-[a-f0-9]{32}$`,
    ).test(identity.buildId)
  )
    throw new Error('Invalid preview build identity');
  return identity;
}

export function previewProfileDirectory(identity: PreviewBuildIdentity): string {
  return `Anvil Preview/${identity.buildId}`;
}

export const previewBuild = parsePreviewBuild(process.env.ANVIL_PREVIEW_BUILD);

/** Embedded at build time. Runtime environment variables cannot select a preview profile. */
interface PreviewBuildIdentityBase {
  buildId: string;
  headSha: string;
  pullRequestNumber: number;
}

export type PreviewBuildIdentity =
  | (PreviewBuildIdentityBase & { platform: 'darwin'; arch: 'arm64' | 'x64' })
  | (PreviewBuildIdentityBase & { platform: 'linux'; arch: 'x64' });

export function parsePreviewBuild(value: string | undefined): PreviewBuildIdentity | null {
  if (!value) return null;
  const data: unknown = JSON.parse(value);
  if (!data || typeof data !== 'object') throw new Error('Invalid preview build identity');
  const identity = data as PreviewBuildIdentity;
  const supportedPlatformArch =
    (identity.platform === 'darwin' && ['arm64', 'x64'].includes(identity.arch)) ||
    (identity.platform === 'linux' && identity.arch === 'x64');
  const buildIdPrefix = `pr-${identity.pullRequestNumber}-${identity.headSha}-${identity.platform}-${identity.arch}-`;
  if (
    !Number.isSafeInteger(identity.pullRequestNumber) ||
    identity.pullRequestNumber <= 0 ||
    typeof identity.headSha !== 'string' ||
    !/^[a-f0-9]{40}$/.test(identity.headSha) ||
    !supportedPlatformArch ||
    typeof identity.buildId !== 'string' ||
    !identity.buildId.startsWith(buildIdPrefix) ||
    !/^[a-f0-9]{32}$/.test(identity.buildId.slice(buildIdPrefix.length))
  )
    throw new Error('Invalid preview build identity');
  return identity;
}

export function previewProfileDirectory(identity: PreviewBuildIdentity): string {
  return `Anvil Preview/${identity.buildId}`;
}

export const previewBuild = parsePreviewBuild(process.env.ANVIL_PREVIEW_BUILD);

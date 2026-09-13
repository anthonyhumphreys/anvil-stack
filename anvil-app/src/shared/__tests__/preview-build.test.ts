import { describe, expect, it } from 'vitest';
import { parsePreviewBuild, previewProfileDirectory } from '../preview-build.js';

const headSha = 'a'.repeat(40);
const identity = {
  buildId: `pr-7-${headSha}-darwin-arm64-${'c'.repeat(32)}`,
  headSha,
  pullRequestNumber: 7,
  platform: 'darwin',
  arch: 'arm64',
};

describe('candidate preview identity', () => {
  it('leaves normal builds on their existing profile', () => {
    expect(parsePreviewBuild(undefined)).toBeNull();
    expect(parsePreviewBuild('')).toBeNull();
  });

  it('isolates each PR commit beneath a preview-only directory', () => {
    const first = parsePreviewBuild(JSON.stringify(identity))!;
    const second = parsePreviewBuild(
      JSON.stringify({
        ...identity,
        headSha: 'b'.repeat(40),
        buildId: `pr-7-${'b'.repeat(40)}-darwin-arm64-${'c'.repeat(32)}`,
      }),
    )!;
    expect(previewProfileDirectory(first)).toBe(`Anvil Preview/${identity.buildId}`);
    expect(previewProfileDirectory(first)).not.toBe(previewProfileDirectory(second));
  });

  it('gives repeated builds of the same commit separate profiles', () => {
    const first = parsePreviewBuild(JSON.stringify(identity))!;
    const rebuilt = parsePreviewBuild(
      JSON.stringify({
        ...identity,
        buildId: `pr-7-${headSha}-darwin-arm64-${'d'.repeat(32)}`,
      }),
    )!;
    expect(previewProfileDirectory(first)).not.toBe(previewProfileDirectory(rebuilt));
  });

  it.each([
    { buildId: '../../Anvil' },
    { headSha: 'main' },
    { pullRequestNumber: 0 },
    { platform: 'linux' },
    { arch: 'other' },
    { headSha: 'b'.repeat(40) },
  ])('rejects malformed or mismatched identity %j', (change) => {
    expect(() => parsePreviewBuild(JSON.stringify({ ...identity, ...change }))).toThrow();
  });
});

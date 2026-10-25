import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShareAudience } from '../../../../cloud/contract/shares.js';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), seal: vi.fn() }));
vi.mock('../sync-backend-client.service.js', () => ({ rpc: mocks.rpc }));
vi.mock('../sync-keyring.service.js', () => ({ sealBytesWithKey: mocks.seal }));

import {
  artifactShareScope,
  isArtifactSharingAvailable,
  configureArtifactShareContext,
  getShareAccessOptions,
  listSharedArtifacts,
  publishSharedArtifact,
  resetArtifactShareForTests,
  revokeSharedArtifact,
  updateSharedArtifact,
} from '../artifact-share.service.js';

interface TestContext {
  apiUrl: string;
  accessToken: string;
  scopeKey?: string;
  features?: string[];
  hosted?: boolean;
}
const link: ShareAudience = { kind: 'link' };
const organization = { kind: 'organization' as const, organizationId: 'anvil_org_team' };
const input = { title: 'Notes', bytes: new Uint8Array([1, 2, 3]), mediaType: 'text/plain' };
const update = {
  shareId: 'shr_test',
  shareKey: Buffer.alloc(32, 7).toString('base64url'),
  bytes: input.bytes,
  mediaType: input.mediaType,
};
let context: TestContext | null;
let responseAudience: ShareAudience | undefined;
let onRpc: ((operation: string) => void) | undefined;
let onUpload: (() => void) | undefined;
const upload = vi.fn<typeof fetch>();

function descriptor(audience = responseAudience) {
  return {
    shareId: 'shr_test',
    title: 'Notes',
    mediaType: 'text/plain',
    byteLength: 13,
    sha256: '0'.repeat(64),
    state: 'published',
    createdAt: '2026-10-25T10:00:00Z',
    publishedAt: '2026-10-25T10:00:00Z',
    expiresAt: '2026-11-25T10:00:00Z',
    revokedAt: null,
    ...(audience === undefined ? {} : { audience }),
  };
}
function useOrganization() {
  context = { ...context!, features: ['share-audiences/1'], hosted: true };
  responseAudience = organization;
}
function switchAccount() {
  context = { ...context!, scopeKey: 'backend:another-account', accessToken: 'another-token' };
}
function operations() {
  return mocks.rpc.mock.calls.map((call) => call[1]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ANVIL_SHARE_BASE_URL', undefined);
  context = {
    apiUrl: 'https://backend.example/v1',
    accessToken: 'original-token',
    scopeKey: 'backend:original-account',
  };
  configureArtifactShareContext(() => context);
  responseAudience = undefined;
  onRpc = undefined;
  onUpload = undefined;
  mocks.seal.mockReturnValue(Buffer.from('sealed-content'));
  mocks.rpc.mockImplementation(async (_backend, operation: string) => {
    const results: Record<string, unknown> = {
      'share.audiences': { organizations: [{ id: organization.organizationId, name: 'Team' }] },
      'share.create': {
        shareId: 'shr_test',
        uploadPath: '/v1/shared/shr_test',
        expiresAt: '2026-11-25T10:00:00Z',
        audience: responseAudience,
      },
      'share.update': {
        uploadPath: '/v1/shared/shr_test',
        expiresAt: '2026-11-25T10:00:00Z',
        audience: responseAudience,
      },
      'share.finalize': { share: descriptor() },
      'share.revoke': { share: { ...descriptor(), state: 'revoked' } },
      'share.list': { shares: [descriptor()] },
    };
    onRpc?.(operation);
    return { result: results[operation] };
  });
  upload.mockImplementation(async () => {
    onUpload?.();
    return new Response(null, { status: 200 });
  });
  vi.stubGlobal('fetch', upload);
});
afterEach(() => {
  resetArtifactShareForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('artifact share transport audience enforcement', () => {
  it.each([
    undefined,
    'not-a-url',
    'http://viewer.example',
    'https://user:password@viewer.example',
    'https://viewer.example?secret=query',
    'https://viewer.example#fragment',
  ])('blocks custom guest shares without a valid paired viewer (%s)', async (viewer) => {
    context!.hosted = false;
    vi.stubEnv('ANVIL_SHARE_BASE_URL', viewer);
    expect(isArtifactSharingAvailable()).toBe(false);
    expect(await getShareAccessOptions()).toEqual({
      available: false,
      organizationSharing: false,
      organizations: [],
    });
    await expect(publishSharedArtifact(input)).rejects.toThrow('ANVIL_SHARE_BASE_URL');
    await expect(updateSharedArtifact(update)).rejects.toThrow('ANVIL_SHARE_BASE_URL');
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });
  it('allows custom guest shares with an explicit HTTPS viewer base path', async () => {
    context!.hosted = false;
    vi.stubEnv('ANVIL_SHARE_BASE_URL', 'https://viewer.example/shared');
    expect(isArtifactSharingAvailable()).toBe(true);
    expect(await getShareAccessOptions()).toEqual({
      available: true,
      organizationSharing: false,
      organizations: [],
    });
    expect((await publishSharedArtifact(input)).share.shareId).toBe('shr_test');
    expect((await updateSharedArtifact(update)).shareId).toBe('shr_test');
  });
  it('uses the default viewer for hosted guest shares', async () => {
    context!.hosted = true;
    expect(isArtifactSharingAvailable()).toBe(true);
    expect((await publishSharedArtifact(input)).share.shareId).toBe('shr_test');
  });
  it('allows revocation even when a custom viewer is no longer configured', async () => {
    context!.hosted = false;
    expect(isArtifactSharingAvailable()).toBe(false);
    await revokeSharedArtifact('shr_test');
    expect(operations()).toEqual(['share.revoke']);
  });

  it('keeps anonymous links compatible with older backends that omit policy', async () => {
    const result = await publishSharedArtifact(input);
    expect(result.share.shareId).toBe('shr_test');
    expect(result.shareKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(operations()).toEqual(['share.create', 'share.finalize']);
    expect(mocks.rpc.mock.calls[0][2]).toMatchObject({ audience: link, sealed: true });
    expect(upload).toHaveBeenCalledOnce();
    const [url, options] = upload.mock.calls[0];
    expect(String(url)).toBe('https://backend.example/v1/shared/shr_test');
    expect(options?.headers).toMatchObject({ Authorization: 'Bearer original-token' });
    expect(options?.redirect).toBe('error');
    expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain(result.shareKey);
  });
  it('requires an active session', async () => {
    context = null;
    expect(await getShareAccessOptions()).toEqual({
      available: false,
      organizationSharing: false,
      organizations: [],
    });
    await expect(publishSharedArtifact(input)).rejects.toThrow('active sync session');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each(['feature', 'viewer'] as const)(
    'blocks restricted sharing without %s support before reserve/upload',
    async (missing) => {
      useOrganization();
      context =
        missing === 'feature' ? { ...context!, features: [] } : { ...context!, hosted: false };
      await expect(publishSharedArtifact({ ...input, audience: organization })).rejects.toThrow(
        'unavailable',
      );
      await expect(updateSharedArtifact({ ...update, audience: organization })).rejects.toThrow(
        'unavailable',
      );
      expect(mocks.rpc).not.toHaveBeenCalled();
      expect(upload).not.toHaveBeenCalled();
    },
  );
  it('requires an explicitly configured valid viewer for a custom backend', async () => {
    useOrganization();
    context!.hosted = false;
    vi.stubEnv('ANVIL_SHARE_BASE_URL', 'not-a-url');
    expect((await getShareAccessOptions()).organizationSharing).toBe(false);
    vi.stubEnv('ANVIL_SHARE_BASE_URL', 'https://viewer.example');
    expect((await getShareAccessOptions()).organizationSharing).toBe(true);
    expect(
      (await publishSharedArtifact({ ...input, audience: organization })).share.audience,
    ).toEqual(organization);
  });
  it('requires current membership before reservation', async () => {
    useOrganization();
    await expect(
      publishSharedArtifact({
        ...input,
        audience: { kind: 'organization', organizationId: 'other_org' },
      }),
    ).rejects.toThrow('unavailable');
    expect(operations()).toEqual(['share.audiences']);
    expect(upload).not.toHaveBeenCalled();
  });
  it.each([undefined, link, { kind: 'organization', organizationId: 'other_org' }] as const)(
    'blocks a restricted reservation policy mismatch before upload (%j)',
    async (policy) => {
      useOrganization();
      responseAudience = policy;
      await expect(publishSharedArtifact({ ...input, audience: organization })).rejects.toThrow(
        'did not confirm',
      );
      expect(operations()).toEqual(['share.audiences', 'share.create']);
      expect(upload).not.toHaveBeenCalled();
    },
  );
  it('confirms organization access and uses the same context for every request', async () => {
    useOrganization();
    expect(
      (await publishSharedArtifact({ ...input, audience: organization })).share.audience,
    ).toEqual(organization);
    expect(operations()).toEqual(['share.audiences', 'share.create', 'share.finalize']);
    for (const call of mocks.rpc.mock.calls) {
      expect(call[0]).toEqual({ apiUrl: 'https://backend.example/v1' });
      expect(call[3]).toBe('original-token');
    }
  });
  it('returns no key/link when finalize downgrades the audience', async () => {
    useOrganization();
    onUpload = () => {
      responseAudience = link;
    };
    await expect(publishSharedArtifact({ ...input, audience: organization })).rejects.toThrow(
      'did not confirm',
    );
    expect(upload).toHaveBeenCalledOnce();
  });
  it('rejects a finalized descriptor for another share', async () => {
    onUpload = () => {
      mocks.rpc.mockResolvedValueOnce({
        result: { share: { ...descriptor(), shareId: 'shr_other' } },
      });
    };
    await expect(publishSharedArtifact(input)).rejects.toThrow('different share');
  });
  it.each(['https://foreign.example/upload', '//foreign.example/upload'])(
    'rejects a foreign upload URL before sending bearer or bytes (%s)',
    async (uploadPath) => {
      mocks.rpc.mockResolvedValueOnce({ result: { shareId: 'shr_test', uploadPath } });
      await expect(publishSharedArtifact(input)).rejects.toThrow('invalid share upload');
      expect(upload).not.toHaveBeenCalled();
    },
  );
  it('requires a restricted update reservation to confirm policy before uploading', async () => {
    useOrganization();
    responseAudience = link;
    await expect(updateSharedArtifact({ ...update, audience: organization })).rejects.toThrow(
      'did not confirm',
    );
    expect(operations()).toEqual(['share.audiences', 'share.update']);
    expect(upload).not.toHaveBeenCalled();
  });
  it('updates restricted shares with active membership and stable policy', async () => {
    useOrganization();
    expect((await updateSharedArtifact({ ...update, audience: organization })).audience).toEqual(
      organization,
    );
    expect(operations()).toEqual(['share.audiences', 'share.update', 'share.finalize']);
  });
  it('fails before upload when an old backend cannot bind a replacement title to its reservation', async () => {
    await expect(updateSharedArtifact({ ...update, title: '[redacted]' })).rejects.toThrow(
      'must be upgraded',
    );
    expect(upload).not.toHaveBeenCalled();
  });
  it('binds replacement title finalization to the returned update token', async () => {
    mocks.rpc.mockResolvedValueOnce({
      result: { uploadPath: '/v1/shared/shr_test', audience: link, updateToken: 'update_token' },
    });
    onUpload = () =>
      mocks.rpc.mockResolvedValueOnce({
        result: { share: { ...descriptor(), title: '[redacted]' } },
      });
    await updateSharedArtifact({ ...update, title: '[redacted]' });
    expect(mocks.rpc.mock.calls[0][2]).toMatchObject({ title: '[redacted]' });
    expect(mocks.rpc.mock.calls[1][2]).toMatchObject({ updateToken: 'update_token' });
  });
  it('refuses to report a title update complete when finalization keeps the old title', async () => {
    mocks.rpc.mockResolvedValueOnce({
      result: { uploadPath: '/v1/shared/shr_test', audience: link, updateToken: 'update_token' },
    });
    await expect(updateSharedArtifact({ ...update, title: '[redacted]' })).rejects.toThrow(
      'replacement share title',
    );
  });
  it('keeps guest updates compatible with older backends', async () => {
    expect((await updateSharedArtifact(update)).shareId).toBe('shr_test');
    expect(operations()).toEqual(['share.update', 'share.finalize']);
  });
});

describe('artifact share context binding', () => {
  it.each(['share.audiences', 'share.create', 'upload', 'share.finalize'])(
    'stops restricted publication when the account changes during %s',
    async (stage) => {
      useOrganization();
      onRpc = (operation) => {
        if (operation === stage) switchAccount();
      };
      if (stage === 'upload') onUpload = switchAccount;
      await expect(publishSharedArtifact({ ...input, audience: organization })).rejects.toThrow(
        'session changed',
      );
      if (stage === 'share.audiences') expect(operations()).toEqual(['share.audiences']);
      if (stage === 'share.create') expect(upload).not.toHaveBeenCalled();
      if (stage === 'upload') expect(operations()).not.toContain('share.finalize');
      expect(mocks.rpc.mock.calls.every((call) => call[3] === 'original-token')).toBe(true);
    },
  );
  it.each(['backend', 'scope', 'features', 'token', 'viewer'])(
    'detects in-place %s changes in the context provider',
    async (field) => {
      onRpc = (operation) => {
        if (operation !== 'share.create') return;
        if (field === 'backend') context!.apiUrl = 'https://other.example/v1';
        if (field === 'scope') context!.scopeKey = 'another-account';
        if (field === 'features') context!.features = ['new-feature'];
        if (field === 'token') context!.accessToken = 'another-token';
        if (field === 'viewer')
          vi.stubEnv('ANVIL_SHARE_BASE_URL', 'https://another-viewer.example');
      };
      await expect(publishSharedArtifact(input)).rejects.toThrow('session changed');
      expect(upload).not.toHaveBeenCalled();
    },
  );
  it('rejects the pre-build expected scope after switching accounts', async () => {
    const expectedScope = artifactShareScope();
    switchAccount();
    await expect(publishSharedArtifact({ ...input, expectedScope })).rejects.toThrow(
      'session changed',
    );
    await expect(updateSharedArtifact({ ...update, expectedScope })).rejects.toThrow(
      'session changed',
    );
    await expect(revokeSharedArtifact('shr_test', { expectedScope })).rejects.toThrow(
      'session changed',
    );
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each(['share.update', 'upload', 'share.finalize'])(
    'stops updates when the account changes during %s',
    async (stage) => {
      onRpc = (operation) => {
        if (operation === stage) switchAccount();
      };
      if (stage === 'upload') onUpload = switchAccount;
      await expect(updateSharedArtifact(update)).rejects.toThrow('session changed');
      if (stage === 'share.update') expect(upload).not.toHaveBeenCalled();
      if (stage === 'upload') expect(operations()).not.toContain('share.finalize');
    },
  );
  it('does not return stale memberships or lists after an account change', async () => {
    useOrganization();
    onRpc = switchAccount;
    await expect(getShareAccessOptions()).rejects.toThrow('session changed');
    context!.scopeKey = 'account-before-list';
    await expect(listSharedArtifacts()).rejects.toThrow('session changed');
  });
  it('rejects a stale RPC failure as a session change so revoke callers cannot swallow it', async () => {
    mocks.rpc.mockImplementationOnce(async () => {
      switchAccount();
      throw new Error('not-found');
    });
    await expect(revokeSharedArtifact('shr_test')).rejects.toThrow('session changed');
  });
  it('checks context when an upload fails and never finalizes under the replacement account', async () => {
    upload.mockImplementationOnce(async () => {
      switchAccount();
      throw new Error('network failed');
    });
    await expect(publishSharedArtifact(input)).rejects.toThrow('session changed');
    expect(operations()).toEqual(['share.create']);
  });
  it('pins revocation credentials and refuses to report completion after a switch', async () => {
    const expectedScope = artifactShareScope();
    onRpc = switchAccount;
    await expect(revokeSharedArtifact('shr_test', { expectedScope })).rejects.toThrow(
      'session changed',
    );
    expect(mocks.rpc).toHaveBeenCalledWith(
      { apiUrl: 'https://backend.example/v1' },
      'share.revoke',
      { shareId: 'shr_test' },
      'original-token',
    );
  });
});

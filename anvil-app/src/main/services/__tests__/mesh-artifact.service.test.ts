import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpcCalls: Array<{ operation: string; params: unknown }> = [];
let rpcHandler: (operation: string, params: unknown) => unknown = () => ({});

vi.mock('../sync-backend-client.service.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../sync-backend-client.service.js')>();
  return {
    ...original,
    rpc: async (
      _connection: unknown,
      operation: string,
      params: unknown,
    ): Promise<{ result: unknown; serverTime: string }> => {
      rpcCalls.push({ operation, params });
      return { result: rpcHandler(operation, params), serverTime: '' };
    },
  };
});

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import {
  configureMeshArtifactContext,
  downloadMeshArtifact,
  getMeshArtifact,
  listMeshArtifacts,
  resetMeshArtifactForTests,
  uploadAttemptArtifact,
} from '../mesh-artifact.service';
import { BackendRpcError } from '../sync-backend-client.service';

const CTX = { apiUrl: 'https://backend.test/', accessToken: 'tok' };

beforeEach(() => {
  rpcCalls.length = 0;
  rpcHandler = () => ({});
  fetchMock.mockReset();
  resetMeshArtifactForTests();
  configureMeshArtifactContext(() => CTX);
});

afterEach(() => {
  resetMeshArtifactForTests();
});

describe('artifact upload', () => {
  it('reserves, PUTs bytes to the upload path, then finalizes', async () => {
    const bytes = new TextEncoder().encode('checkpoint-bytes');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    rpcHandler = (op, _params) => {
      if (op === 'artifact.reserve') {
        return { artifactId: 'art-1', uploadPath: 'v1/artifacts/art-1', expiresAt: 't' };
      }
      if (op === 'artifact.finalize') {
        return {
          manifest: {
            id: 'art-1',
            attemptId: 'att-1',
            byteLength: bytes.byteLength,
            sha256,
            mediaType: 'application/json',
            retentionDays: 30,
            state: 'published',
          },
        };
      }
      return {};
    };
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    const manifest = await uploadAttemptArtifact({
      attemptId: 'att-1',
      bytes,
      mediaType: 'application/json',
    });

    expect(manifest.state).toBe('published');
    expect(rpcCalls.map((c) => c.operation)).toEqual([
      'artifact.reserve',
      'artifact.finalize',
    ]);
    const reserve = rpcCalls[0].params as { byteLength: number; sha256: string };
    expect(reserve.byteLength).toBe(bytes.byteLength);
    expect(reserve.sha256).toBe(sha256);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('https://backend.test/v1/artifacts/art-1');
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('propagates an upload HTTP failure instead of finalizing', async () => {
    rpcHandler = () => ({
      artifactId: 'art-1',
      uploadPath: 'v1/artifacts/art-1',
      expiresAt: 't',
    });
    fetchMock.mockResolvedValue(new Response('no', { status: 413 }));
    await expect(
      uploadAttemptArtifact({
        attemptId: 'att-1',
        bytes: new Uint8Array([1]),
        mediaType: 'application/octet-stream',
      }),
    ).rejects.toThrow('413');
    expect(rpcCalls.some((c) => c.operation === 'artifact.finalize')).toBe(false);
  });
});

describe('artifact download', () => {
  it('fetches bytes from the returned downloadPath and verifies sha256', async () => {
    const bytes = new TextEncoder().encode('payload');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    rpcHandler = () => ({
      artifact: {
        id: 'art-9',
        attemptId: 'att-1',
        jobId: 'job-1',
        byteLength: bytes.byteLength,
        sha256,
        mediaType: 'text/plain',
        retentionDays: 30,
        state: 'published',
      },
      downloadPath: 'v1/artifacts/art-9',
    });
    fetchMock.mockResolvedValue(new Response(new Uint8Array(bytes), { status: 200 }));
    const got = await downloadMeshArtifact('art-9');
    expect(new TextDecoder().decode(got)).toBe('payload');
    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.toString()).toBe('https://backend.test/v1/artifacts/art-9');
  });

  it('rejects a checksum mismatch — corrupted bytes never surface', async () => {
    rpcHandler = () => ({
      artifact: {
        id: 'art-9',
        attemptId: 'att-1',
        byteLength: 4,
        sha256: 'deadbeef',
        mediaType: 'text/plain',
        retentionDays: 30,
        state: 'published',
      },
      downloadPath: 'v1/artifacts/art-9',
    });
    fetchMock.mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));
    await expect(downloadMeshArtifact('art-9')).rejects.toThrow('checksum');
  });

  it('rejects when downloadPath is absent (not published)', async () => {
    rpcHandler = () => ({
      artifact: {
        id: 'art-9',
        attemptId: 'att-1',
        byteLength: 4,
        sha256: 'x',
        mediaType: 'text/plain',
        retentionDays: 30,
        state: 'reserved',
      },
      downloadPath: null,
    });
    await expect(downloadMeshArtifact('art-9')).rejects.toThrow('not published');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('artifact listing/get', () => {
  it('lists descriptors for an attempt', async () => {
    rpcHandler = () => ({ artifacts: [{ id: 'a1' }, { id: 'a2' }] });
    const list = await listMeshArtifacts({ attemptId: 'att-1' });
    expect(list).toHaveLength(2);
    expect(rpcCalls[0].params).toEqual({ attemptId: 'att-1' });
  });

  it('returns null when the artifact lookup fails', async () => {
    rpcHandler = () => {
      throw new BackendRpcError({ code: 'not-found', retryable: false });
    };
    expect(await getMeshArtifact('missing')).toBeNull();
  });
});

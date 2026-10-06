import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  discover: vi.fn(),
  status: vi.fn(),
  pin: vi.fn(),
  runtime: vi.fn(),
  signIn: vi.fn(),
}));
vi.mock('../sync-backend-client.service.js', () => ({
  discover: mocks.discover,
  normalizeBaseUrl: (url: string) => new URL('.', `${url.replace(/\/$/, '')}/`).href,
}));
vi.mock('../sync-backend.service.js', () => ({
  getBackendStatus: mocks.status,
  pinBackend: mocks.pin,
}));
vi.mock('../sync-runtime.service.js', () => ({
  getRuntimeStatus: mocks.runtime,
  signInWithOidc: mocks.signIn,
}));
import { connectHostedSync } from '../sync-setup.service';

const signedOut = { state: 'signed-out', accountId: null, enrollmentId: null };
const signedIn = { state: 'signed-in', accountId: 'account', enrollmentId: 'device' };
const initialStatus = {
  hostedBackendUrl: 'https://sync.example.com/',
  backendId: null,
  baseUrl: null,
  state: null,
  identityReviewRequired: false,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.status.mockReturnValue(initialStatus);
  mocks.runtime.mockReturnValue({ auth: signedOut, sessionExpired: false });
  mocks.discover.mockResolvedValue({
    baseUrl: 'https://sync.example.com/',
    descriptor: { deploymentId: 'hosted' },
  });
  mocks.pin.mockImplementation(() => {
    mocks.status.mockReturnValue({ ...initialStatus, backendId: 'hosted' });
    return { id: 'hosted', identityReviewRequired: false };
  });
  mocks.signIn.mockResolvedValue(signedIn);
});

describe('one-action hosted sign-in', () => {
  it('uses the configured service and pins it before browser sign-in', async () => {
    expect(await connectHostedSync()).toEqual(signedIn);
    expect(mocks.discover).toHaveBeenCalledWith('https://sync.example.com/');
    expect(mocks.pin).toHaveBeenCalledWith({
      baseUrl: 'https://sync.example.com/',
      descriptor: { deploymentId: 'hosted' },
      connectionMode: 'hosted',
    });
    expect(mocks.pin.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.signIn.mock.invocationCallOrder[0]!,
    );
  });

  it('deduplicates browser sign-in and allows retry after failure', async () => {
    mocks.signIn.mockRejectedValueOnce(new Error('cancelled'));
    const first = connectHostedSync();
    expect(connectHostedSync()).toBe(first);
    await expect(first).rejects.toThrow('cancelled');
    expect(await connectHostedSync()).toEqual(signedIn);
    expect(mocks.signIn).toHaveBeenCalledTimes(2);
  });

  it('blocks a changed pinned identity before discovery', async () => {
    mocks.status.mockReturnValue({ ...initialStatus, identityReviewRequired: true });
    await expect(connectHostedSync()).rejects.toThrow('Review it in settings');
    expect(mocks.discover).not.toHaveBeenCalled();
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it('blocks identity changes discovered during pinning', async () => {
    mocks.pin.mockReturnValue({ id: 'hosted', identityReviewRequired: true });
    await expect(connectHostedSync()).rejects.toThrow('Review it in settings');
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it('does not silently replace a signed-in custom service', async () => {
    mocks.status.mockReturnValue({ ...initialStatus, baseUrl: 'https://custom.example.com/' });
    mocks.runtime.mockReturnValue({ auth: signedIn, sessionExpired: false });
    await expect(connectHostedSync()).rejects.toThrow('Disconnect your current service');
    expect(mocks.discover).not.toHaveBeenCalled();
  });

  it('rejects a connection changed while discovery is in flight', async () => {
    mocks.discover.mockImplementation(async () => {
      mocks.status.mockReturnValue({ ...initialStatus, backendId: 'different' });
      return { baseUrl: 'https://sync.example.com/', descriptor: {} };
    });
    await expect(connectHostedSync()).rejects.toThrow('connection changed');
    expect(mocks.pin).not.toHaveBeenCalled();
  });

  it('shows an actionable error when this build has no hosted endpoint', async () => {
    mocks.status.mockReturnValue({ ...initialStatus, hostedBackendUrl: null });
    await expect(connectHostedSync()).rejects.toThrow('custom service');
    expect(mocks.discover).not.toHaveBeenCalled();
  });
});

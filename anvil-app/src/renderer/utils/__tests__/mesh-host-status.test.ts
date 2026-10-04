import { describe, expect, it } from 'vitest';
import type { MeshMachineHostStatus } from '../../../../cloud/contract/machine.js';
import { summarizeLocalMeshHostStatus } from '../mesh-host-status';

const baseHost: MeshMachineHostStatus = {
  enabled: true,
  running: true,
  state: 'listening',
  machineId: 'machine-secret-id',
  endpointGeneration: 'generation-secret-id',
  protocolVersion: 1,
  capabilities: ['machine.session/1'],
  activeSessions: 0,
  managedOrigin: null,
};

describe('summarizeLocalMeshHostStatus', () => {
  it('asks the user to sign in before making this device available', () => {
    expect(
      summarizeLocalMeshHostStatus({
        host: baseHost,
        loading: false,
        signedIn: false,
        syncEnabled: false,
        backendReady: true,
      }),
    ).toMatchObject({
      value: 'Not available',
      detail: 'Sign in, then enable Sync to let approved devices connect.',
    });
  });

  it('keeps Local as a clear choice when no Sync service is configured', () => {
    expect(
      summarizeLocalMeshHostStatus({
        host: baseHost,
        loading: false,
        signedIn: false,
        syncEnabled: false,
        backendReady: false,
      }),
    ).toMatchObject({
      value: 'Not available',
      detail: 'Choose a Sync service and sign in to connect approved devices.',
    });
  });

  it('keeps a disabled direct route separate from Sync availability', () => {
    expect(
      summarizeLocalMeshHostStatus({
        host: { ...baseHost, enabled: false, state: 'disabled' },
        loading: false,
        signedIn: false,
        syncEnabled: false,
        backendReady: true,
      }),
    ).toMatchObject({
      value: 'Direct connections unavailable',
      detail: expect.stringContaining('Sync remains available'),
    });
  });

  it('points an offline private listener at network reachability', () => {
    expect(
      summarizeLocalMeshHostStatus({
        host: { ...baseHost, state: 'offline', running: false },
        loading: false,
        signedIn: true,
        syncEnabled: true,
        backendReady: true,
      }),
    ).toMatchObject({
      value: 'Offline',
      detail: 'Keep Anvil open on a network the other device can reach.',
    });
  });

  it('gives a sanitized repair action when the listener cannot start', () => {
    const summary = summarizeLocalMeshHostStatus({
      host: { ...baseHost, state: 'bind-error', lastErrorCode: 'listener-bind-failed' },
      loading: false,
      signedIn: true,
      syncEnabled: true,
      backendReady: true,
    });

    expect(summary).toMatchObject({
      value: 'Needs attention',
      detail: 'Connection service could not start. Restart Anvil.',
      tone: 'text-error',
    });
    expect(JSON.stringify(summary)).not.toContain('machine-secret-id');
  });

  it('explains the reachability requirement for a private-network listener', () => {
    expect(
      summarizeLocalMeshHostStatus({
        host: baseHost,
        loading: false,
        signedIn: true,
        syncEnabled: true,
        backendReady: true,
      }),
    ).toMatchObject({
      value: 'Available on your network',
      detail: 'Keep Anvil open. Other devices must be able to reach this network.',
    });
  });

  it('shows active connections without exposing host identity or route metadata', () => {
    const summary = summarizeLocalMeshHostStatus({
      host: {
        ...baseHost,
        activeSessions: 2,
        managedOrigin: 'https://private.example.invalid',
      },
      loading: false,
      signedIn: true,
      syncEnabled: true,
      backendReady: true,
    });

    expect(summary).toMatchObject({
      value: 'Connected',
      detail: '2 active connections · keep Anvil open and online.',
    });
    expect(JSON.stringify(summary)).not.toContain('private.example.invalid');
    expect(JSON.stringify(summary)).not.toContain('generation-secret-id');
  });
});

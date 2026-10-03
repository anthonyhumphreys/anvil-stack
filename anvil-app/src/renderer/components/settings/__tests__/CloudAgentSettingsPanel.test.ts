import { describe, expect, it } from 'vitest';
import type { CloudAgentProviderStatus } from '../../../../shared/cloud-agent';
import { cloudAgentStatusLabel } from '../CloudAgentSettingsPanel';

describe('cloudAgentStatusLabel', () => {
  it('asks the user to allow a provider before showing connection state', () => {
    const status: CloudAgentProviderStatus = {
      provider: 'cursor',
      enabled: false,
      connected: false,
      connectionState: 'connected',
    };
    expect(cloudAgentStatusLabel(status)).toBe('Not allowed');
  });

  it('shows connection and credential recovery states', () => {
    const base = { provider: 'devin' as const, enabled: true, connected: false };
    expect(cloudAgentStatusLabel({ ...base, connectionState: 'connected' })).toBe('Connected');
    expect(cloudAgentStatusLabel({ ...base, connectionState: 'locked' })).toBe(
      'Unlock saved credentials',
    );
    expect(cloudAgentStatusLabel({ ...base, connectionState: 'expired' })).toBe(
      'Connection expired',
    );
  });
});

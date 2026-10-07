import { describe, expect, it } from 'vitest';
import { remoteChatConnectionNotice } from '../remote-chat-connection-status';

const base = {
  approvalRequired: false,
  approvalActionsAvailable: false,
  targetName: 'Build machine',
  fallbackLabel: 'Working',
};

describe('remote chat connection notice', () => {
  it('states when the target is connected', () => {
    expect(remoteChatConnectionNotice({ ...base, hostState: 'live' })).toEqual({
      label: 'Connected · Build machine',
      detail: null,
      tone: 'muted',
    });
  });

  it('explains automatic connection and retry states', () => {
    expect(remoteChatConnectionNotice({ ...base, hostState: 'connecting' }).detail).toContain(
      'connecting automatically',
    );
    expect(remoteChatConnectionNotice({ ...base, hostState: 'offline' })).toMatchObject({
      label: 'Build machine is offline',
      tone: 'warning',
    });
  });

  it('shows delayed updates when the connection is using its fallback', () => {
    expect(remoteChatConnectionNotice({ ...base, hostState: 'degraded' }).detail).toBe(
      'Connected, but live updates may be delayed.',
    );
  });

  it.each(['approval-required', 'device-denied'] as const)(
    'gives host access guidance for %s instead of calling the machine offline',
    (hostError) => {
      const notice = remoteChatConnectionNotice({ ...base, hostState: 'offline', hostError });
      expect(notice.detail).toContain('Settings → Devices → Account device access');
      expect(notice.label).not.toContain('offline');
      expect(notice.tone).toBe('warning');
    },
  );

  it('puts an approval request ahead of connection state', () => {
    expect(
      remoteChatConnectionNotice({
        ...base,
        hostState: 'live',
        approvalRequired: true,
        approvalActionsAvailable: true,
      }),
    ).toEqual({
      label: 'Approval required',
      detail: 'Approve or deny the request below to continue.',
      tone: 'warning',
    });
  });

  it('keeps the existing run label when no host route status is available', () => {
    expect(remoteChatConnectionNotice({ ...base, hostState: undefined })).toEqual({
      label: 'Working',
      detail: null,
      tone: 'muted',
    });
  });
});

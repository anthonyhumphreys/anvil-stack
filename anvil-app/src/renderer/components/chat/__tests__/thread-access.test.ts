import { describe, expect, it } from 'vitest';
import {
  CHAT_ACCESS_LEVELS,
  chatAccessLevelIsElevated,
  chatAccessLevelLabel,
  chatAccessLevelRequiresConfirm,
  chatAccessLevelShortLabel,
  chatAccessOptionSelected,
  chatAccessOptionsForProvider,
  chatAppliedModeLabel,
  expectedAcpAppliedMode,
  isChatAccessLevel,
  markAccessLevelApplied,
  reconcileThreadAccessStore,
  resolveChatAccessChipLabel,
  resolveThreadAccessLevel,
  setThreadAccessLevel,
  type ThreadAccessStore,
} from '../thread-access';

describe('chatAccessLevelLabel', () => {
  it('maps every codex mode to the CH1 user-facing label', () => {
    expect(chatAccessLevelLabel('read-only')).toBe('Read only');
    expect(chatAccessLevelLabel('on-request')).toBe('Ask for extra access');
    expect(chatAccessLevelLabel('workspace-auto')).toBe('Auto in workspace');
    expect(chatAccessLevelLabel('full-access')).toBe('Full access');
  });

  it('covers every level in CHAT_ACCESS_LEVELS', () => {
    for (const level of CHAT_ACCESS_LEVELS) {
      expect(chatAccessLevelLabel(level)).toBeTruthy();
      expect(chatAccessLevelShortLabel(level)).toBeTruthy();
    }
  });
});

describe('chatAccessLevelIsElevated', () => {
  it('flags auto-approve and full-access as elevated', () => {
    expect(chatAccessLevelIsElevated('workspace-auto')).toBe(true);
    expect(chatAccessLevelIsElevated('full-access')).toBe(true);
  });

  it('treats read-only and on-request as neutral', () => {
    expect(chatAccessLevelIsElevated('read-only')).toBe(false);
    expect(chatAccessLevelIsElevated('on-request')).toBe(false);
  });
});

describe('chatAccessLevelRequiresConfirm', () => {
  it('only requires confirmation for full access', () => {
    expect(chatAccessLevelRequiresConfirm('full-access')).toBe(true);
    expect(chatAccessLevelRequiresConfirm('workspace-auto')).toBe(false);
    expect(chatAccessLevelRequiresConfirm('on-request')).toBe(false);
    expect(chatAccessLevelRequiresConfirm('read-only')).toBe(false);
  });
});

describe('isChatAccessLevel', () => {
  it('accepts valid levels and rejects anything else', () => {
    expect(isChatAccessLevel('full-access')).toBe(true);
    expect(isChatAccessLevel('yolo')).toBe(false);
    expect(isChatAccessLevel(undefined)).toBe(false);
    expect(isChatAccessLevel(4)).toBe(false);
  });
});

describe('resolveThreadAccessLevel', () => {
  const store: ThreadAccessStore = {
    defaultLevel: 'on-request',
    appliedLevel: 'on-request',
    threads: { 'thread-1': 'workspace-auto' },
  };

  it('returns the per-thread override when present', () => {
    expect(resolveThreadAccessLevel(store, 'thread-1')).toBe('workspace-auto');
  });

  it('falls back to the workspace default for unknown threads', () => {
    expect(resolveThreadAccessLevel(store, 'thread-2')).toBe('on-request');
    expect(resolveThreadAccessLevel(store, null)).toBe('on-request');
  });

  it('falls back to on-request without a store', () => {
    expect(resolveThreadAccessLevel(null, 'thread-1')).toBe('on-request');
  });
});

describe('setThreadAccessLevel', () => {
  const base: ThreadAccessStore = {
    defaultLevel: 'on-request',
    appliedLevel: null,
    threads: {},
  };

  it('records a per-thread override', () => {
    const next = setThreadAccessLevel(base, 't1', 'full-access');
    expect(next.threads.t1).toBe('full-access');
    expect(base.threads.t1).toBeUndefined();
  });

  it('updates the default when there is no thread', () => {
    const next = setThreadAccessLevel(base, null, 'read-only');
    expect(next.defaultLevel).toBe('read-only');
  });
});

describe('reconcileThreadAccessStore', () => {
  it('keeps the store when settings match what we applied', () => {
    const store: ThreadAccessStore = {
      defaultLevel: 'read-only',
      appliedLevel: 'read-only',
      threads: {},
    };
    expect(reconcileThreadAccessStore(store, 'read-only')).toBe(store);
  });

  it('adopts an externally changed settings value as the default', () => {
    const store: ThreadAccessStore = {
      defaultLevel: 'on-request',
      appliedLevel: 'on-request',
      threads: { t1: 'full-access' },
    };
    const next = reconcileThreadAccessStore(store, 'workspace-auto');
    expect(next.defaultLevel).toBe('workspace-auto');
    expect(next.threads.t1).toBe('full-access');
  });
});

describe('markAccessLevelApplied', () => {
  it('records the applied level without mutating overrides', () => {
    const store: ThreadAccessStore = {
      defaultLevel: 'on-request',
      appliedLevel: null,
      threads: { t1: 'read-only' },
    };
    const next = markAccessLevelApplied(store, 'read-only');
    expect(next.appliedLevel).toBe('read-only');
    expect(next.threads.t1).toBe('read-only');
  });
});

// ---------------------------------------------------------------------------
// H9 — provider-truthful access options
// ---------------------------------------------------------------------------

describe('chatAccessOptionsForProvider', () => {
  it('returns the four CodexMode levels for Codex-family providers', () => {
    const options = chatAccessOptionsForProvider('codex');
    expect(options.map((option) => option.level)).toEqual([
      'read-only',
      'on-request',
      'workspace-auto',
      'full-access',
    ]);
    expect(options.every((option) => option.appliedMode === undefined)).toBe(true);
  });

  it('returns Cursor modes ask/agent/plan mapped to transport levels', () => {
    const options = chatAccessOptionsForProvider('cursor');
    expect(options.map((option) => option.appliedMode)).toEqual(['ask', 'agent', 'plan']);
    expect(options[0].level).toBe('read-only');
    expect(options[1].level).toBe('on-request');
    expect(options[2].collaborationMode).toBe('plan');
    expect(options[2].level).toBeNull();
  });

  it('returns the full Devin mode list including smart and bypass', () => {
    const options = chatAccessOptionsForProvider('devin');
    expect(options.map((option) => option.appliedMode)).toEqual([
      'ask',
      'accept-edits',
      'smart',
      'bypass',
      'plan',
    ]);
    expect(options.find((option) => option.appliedMode === 'bypass')?.elevated).toBe(true);
    expect(options.find((option) => option.appliedMode === 'smart')?.level).toBe('workspace-auto');
  });

  it('honours a session-advertised accessModes subset and drops unknown ids', () => {
    const options = chatAccessOptionsForProvider('devin', ['ask', 'bogus-mode']);
    expect(options.map((option) => option.appliedMode)).toEqual(['ask']);
  });
});

describe('expectedAcpAppliedMode', () => {
  it('is undefined for Codex-family providers', () => {
    expect(expectedAcpAppliedMode('codex', 'full-access')).toBeUndefined();
    expect(expectedAcpAppliedMode(undefined, 'full-access')).toBeUndefined();
  });

  it('maps Devin levels onto accept-edits/smart/bypass', () => {
    expect(expectedAcpAppliedMode('devin', 'read-only')).toBe('ask');
    expect(expectedAcpAppliedMode('devin', 'on-request')).toBe('accept-edits');
    expect(expectedAcpAppliedMode('devin', 'workspace-auto')).toBe('smart');
    expect(expectedAcpAppliedMode('devin', 'full-access')).toBe('bypass');
  });

  it('collapses Cursor levels onto ask/agent', () => {
    expect(expectedAcpAppliedMode('cursor', 'read-only')).toBe('ask');
    expect(expectedAcpAppliedMode('cursor', 'full-access')).toBe('agent');
  });

  it('plan collaboration mode wins over the level', () => {
    expect(expectedAcpAppliedMode('devin', 'full-access', 'plan')).toBe('plan');
    expect(expectedAcpAppliedMode('cursor', 'on-request', 'plan')).toBe('plan');
  });

  it('clamps to read-only when the persona cannot write files', () => {
    expect(expectedAcpAppliedMode('devin', 'full-access', 'default', false)).toBe('ask');
  });
});

describe('chatAppliedModeLabel', () => {
  it('labels ACP mode ids and ignores Codex internals', () => {
    expect(chatAppliedModeLabel('ask')).toBe('Read only');
    expect(chatAppliedModeLabel('accept-edits')).toBe('Accept edits');
    expect(chatAppliedModeLabel('smart')).toBe('Auto approve');
    expect(chatAppliedModeLabel('bypass')).toBe('Full access');
    expect(chatAppliedModeLabel('plan')).toBe('Plan');
    expect(chatAppliedModeLabel('workspace-write')).toBeNull();
  });
});

describe('chatAccessOptionSelected / resolveChatAccessChipLabel', () => {
  const devinOptions = chatAccessOptionsForProvider('devin');

  it('prefers the applied provider mode over the stored level', () => {
    const smart = devinOptions.find((option) => option.appliedMode === 'smart')!;
    const bypass = devinOptions.find((option) => option.appliedMode === 'bypass')!;
    // Stored level says full-access but the provider applied 'smart'.
    expect(chatAccessOptionSelected(smart, 'full-access', 'smart')).toBe(true);
    expect(chatAccessOptionSelected(bypass, 'full-access', 'smart')).toBe(false);
  });

  it('falls back to level matching when no applied mode is known', () => {
    const ask = devinOptions.find((option) => option.appliedMode === 'ask')!;
    expect(chatAccessOptionSelected(ask, 'read-only')).toBe(true);
    expect(chatAccessOptionSelected(ask, 'full-access')).toBe(false);
  });

  it('labels the chip with the applied mode when it differs', () => {
    expect(resolveChatAccessChipLabel(devinOptions, 'full-access', 'smart')).toBe('Auto approve');
    expect(resolveChatAccessChipLabel(devinOptions, 'on-request', 'accept-edits')).toBe(
      'Accept edits',
    );
    expect(resolveChatAccessChipLabel(devinOptions, 'on-request')).toBe('Accept edits');
  });

  it('labels plan mode from either the option or the applied id', () => {
    const cursorOptions = chatAccessOptionsForProvider('cursor');
    expect(resolveChatAccessChipLabel(cursorOptions, 'on-request', 'plan')).toBe('Plan');
  });
});

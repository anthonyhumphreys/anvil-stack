import { describe, expect, it } from 'vitest';
import {
  buildAcpPrintInvocation,
  resolveCursorPrintModeArgs,
  resolveDevinCliPermissionMode,
} from '../acp-print-cli.js';
import type { CodexMode } from '../../../shared/types.js';

const WRITING = { approvalPolicy: 'never' as const, sandbox: 'workspace-write' as const };
const READ_ONLY = { approvalPolicy: 'on-request' as const, sandbox: 'read-only' as const };
const FULL = { approvalPolicy: 'never' as const, sandbox: 'danger-full-access' as const };

describe('resolveDevinCliPermissionMode (H7)', () => {
  it('maps Anvil access levels onto real devin --permission-mode values', () => {
    expect(resolveDevinCliPermissionMode('read-only', WRITING)).toBe('auto');
    expect(resolveDevinCliPermissionMode('on-request', WRITING)).toBe('accept-edits');
    expect(resolveDevinCliPermissionMode('workspace-auto', WRITING)).toBe('smart');
    expect(resolveDevinCliPermissionMode('full-access', WRITING)).toBe('dangerous');
  });

  it('a read-only persona clamp wins over a permissive access level', () => {
    expect(resolveDevinCliPermissionMode('full-access', READ_ONLY)).toBe('auto');
    expect(resolveDevinCliPermissionMode('workspace-auto', READ_ONLY)).toBe('auto');
  });

  it('uses only modes the devin CLI accepts', () => {
    const valid = new Set(['auto', 'accept-edits', 'smart', 'dangerous']);
    for (const mode of ['read-only', 'on-request', 'workspace-auto', 'full-access'] as CodexMode[]) {
      for (const policy of [WRITING, READ_ONLY, FULL]) {
        expect(valid).toContain(resolveDevinCliPermissionMode(mode, policy));
      }
    }
  });
});

describe('resolveCursorPrintModeArgs', () => {
  it('forces read-only policies into --mode ask', () => {
    expect(resolveCursorPrintModeArgs('workspace-auto', READ_ONLY)).toEqual(['--mode', 'ask']);
    expect(resolveCursorPrintModeArgs('read-only', WRITING)).toEqual(['--mode', 'ask']);
  });

  it('maps workspace-auto and full-access to the matching flags', () => {
    expect(resolveCursorPrintModeArgs('workspace-auto', WRITING)).toEqual(['--auto-review']);
    expect(resolveCursorPrintModeArgs('full-access', FULL)).toEqual(['--force']);
    expect(resolveCursorPrintModeArgs('on-request', WRITING)).toEqual([]);
  });
});

describe('buildAcpPrintInvocation', () => {
  it('builds a devin --print invocation with the mapped permission mode', () => {
    const { executable, args } = buildAcpPrintInvocation({
      provider: 'devin',
      model: 'swe-2-max',
      mode: 'workspace-auto',
      policy: WRITING,
      prompt: 'do the thing',
    });
    expect(executable).toBe('devin');
    expect(args).toEqual([
      '--print',
      '--permission-mode',
      'smart',
      '--respect-workspace-trust',
      'false',
      '--model',
      'swe-2-max',
      '--',
      'do the thing',
    ]);
  });

  it('omits --model for the devin auto default and clamps read-only to auto', () => {
    const { args } = buildAcpPrintInvocation({
      provider: 'devin',
      model: 'auto',
      mode: 'full-access',
      policy: READ_ONLY,
      prompt: 'look only',
    });
    expect(args).toContain('auto');
    expect(args).not.toContain('--model');
    expect(args.indexOf('--permission-mode')).toBe(args.indexOf('auto') - 1);
  });

  it('builds a cursor print invocation with model and mode flags', () => {
    const { executable, args } = buildAcpPrintInvocation({
      provider: 'cursor',
      model: 'claude-fable-5',
      mode: 'workspace-auto',
      policy: WRITING,
      prompt: 'run it',
    });
    expect(executable).toBe('cursor-agent');
    expect(args).toEqual([
      '-p',
      '--output-format',
      'text',
      '--model',
      'claude-fable-5',
      '--auto-review',
      'run it',
    ]);
  });
});

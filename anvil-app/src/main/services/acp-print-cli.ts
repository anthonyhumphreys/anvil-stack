// One-shot print-mode invocations for ACP providers (H6/H7).
//
// Background execution paths (workflows, automations) cannot drive the
// interactive ACP stdio handshake — they run `cursor-agent -p` /
// `devin --print` instead. This module owns the argv so every caller maps
// the resolved access policy the same way instead of hard-coding a mode.
//
// Devin --permission-mode values (from `devin --help`):
//   auto         auto-approves read-only tools only
//   accept-edits also auto-approves workspace edits
//   smart        additionally auto-runs actions a fast model judges safe
//   dangerous    auto-approves all tools
// Cursor print mode flags (from `cursor-agent --help`):
//   --mode ask|plan  read-only modes
//   --auto-review    server classifier auto-runs safe tool calls
//   --force          allow commands unless explicitly denied

import type { AcpAgentProvider } from '../../shared/agent-providers.js';
import type { CodexMode } from '../../shared/types.js';

/** The persona-clamped policy shape produced by resolvePersonaCodexPolicy. */
export interface AcpAccessPolicy {
  approvalPolicy: 'on-request' | 'never';
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
}

export interface AcpPrintInvocation {
  executable: string;
  args: string[];
  label: string;
}

/**
 * Map Anvil's access level + persona clamp onto Devin's --permission-mode.
 * A read-only policy (persona canWriteFiles:false, plan mode, or the
 * read-only level) lands on `auto`, which auto-approves only read-only
 * tools — in print mode anything else simply cannot be approved.
 */
export function resolveDevinCliPermissionMode(mode: CodexMode, policy: AcpAccessPolicy): string {
  if (policy.sandbox === 'read-only' || mode === 'read-only') return 'auto';
  switch (mode) {
    case 'workspace-auto':
      return 'smart';
    case 'full-access':
      return 'dangerous';
    case 'on-request':
    default:
      return 'accept-edits';
  }
}

/** Print-mode flags that honour the resolved policy for Cursor. */
export function resolveCursorPrintModeArgs(mode: CodexMode, policy: AcpAccessPolicy): string[] {
  if (policy.sandbox === 'read-only' || mode === 'read-only') return ['--mode', 'ask'];
  switch (mode) {
    case 'workspace-auto':
      return ['--auto-review'];
    case 'full-access':
      return ['--force'];
    default:
      return [];
  }
}

export function acpProviderLabel(provider: AcpAgentProvider): string {
  return provider === 'devin' ? 'Devin' : 'Cursor';
}

/** Build the print-mode argv for a one-shot ACP run. */
export function buildAcpPrintInvocation(input: {
  provider: AcpAgentProvider;
  model?: string;
  mode: CodexMode;
  policy: AcpAccessPolicy;
  prompt: string;
}): AcpPrintInvocation {
  const label = acpProviderLabel(input.provider);
  if (input.provider === 'devin') {
    return {
      executable: 'devin',
      label,
      args: [
        '--print',
        '--permission-mode',
        resolveDevinCliPermissionMode(input.mode, input.policy),
        '--respect-workspace-trust',
        'false',
        ...(input.model && input.model !== 'auto' ? ['--model', input.model] : []),
        '--',
        input.prompt,
      ],
    };
  }
  return {
    executable: 'cursor-agent',
    label,
    args: [
      '-p',
      '--output-format',
      'text',
      '--model',
      input.model?.trim() || 'auto',
      ...resolveCursorPrintModeArgs(input.mode, input.policy),
      input.prompt,
    ],
  };
}

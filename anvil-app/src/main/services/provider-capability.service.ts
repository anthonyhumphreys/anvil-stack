// SESSION-01: provider portability capability matrix (spec §11).
//
// Every provider adapter declares how a session continues: `native-resume`,
// `checkpoint-import`, `summary-continuation`, or `unsupported` — with the
// evidence that claim rests on. A provider thread id is not proof of
// portability: a mode is only declared when the code path actually
// exercises it, and `verified` stays false until a fixture proves it.
//
// This registry encodes docs/plans/sync-mesh/session-01-provider-
// portability-audit.md. SESSION-02's remote start and SESSION-03's handoff
// read it rather than re-deriving capability from whatever fields happen
// to be populated.

import type { AgentProvider } from '../../shared/types.js';
import type { ProviderContinuationMode } from '../../../cloud/contract/handoff.js';

export interface ProviderMode {
  mode: ProviderContinuationMode;
  /**
   * `same-home` resume re-opens the thread on the device and CODEX_HOME
   * that created it (worker restart, inspect-retry). `cross-device` is a
   * Mesh-level claim — none is verified yet.
   */
  scope: 'same-home' | 'cross-device';
  /** True only with a passing fixture; absence of a fixture is unverified. */
  verified: boolean;
}

export interface ProviderCapability {
  provider: AgentProvider;
  /** Minimum CLI version the evidence was audited against, when known. */
  cliMinVersion?: string;
  /** Declared continuation modes, strongest first. */
  modes: ProviderMode[];
  /** Code path the claims rest on — audit evidence, not prose. */
  evidence: string;
  /** Honest limitation shown in UX — never claim silent fidelity. */
  caveat?: string;
}

/**
 * The audited matrix. Codex-protocol providers (codex/azure/openai) all
 * spawn `codex app-server` and share `thread/resume` + `thread/fork`;
 * resume re-reads CLI state under `~/.codex`, so it is same-home only
 * until a second-home fixture proves import. Cursor runs ACP
 * `session/new` only — no `session/load` exists in this codebase — so it
 * cannot continue a session at all today; `summary-continuation` is the
 * latent path (checkpoint messages/summary start a NEW thread) and stays
 * unverified until SESSION-03 implements it.
 */
const PROVIDER_CAPABILITIES: Record<AgentProvider, ProviderCapability> = {
  codex: {
    provider: 'codex',
    modes: [
      { mode: 'native-resume', scope: 'same-home', verified: true },
      { mode: 'summary-continuation', scope: 'cross-device', verified: false },
    ],
    evidence: 'codex-session.service.ts: thread/resume + thread/fork',
    caveat: 'native-resume re-opens the thread on the same CODEX_HOME only.',
  },
  azure: {
    provider: 'azure',
    modes: [
      { mode: 'native-resume', scope: 'same-home', verified: true },
      { mode: 'summary-continuation', scope: 'cross-device', verified: false },
    ],
    evidence: 'codex-session.service.ts: codex app-server model_provider="azure"',
    caveat: 'Azure deployments carry org policy; a resumed thread still obeys it.',
  },
  openai: {
    provider: 'openai',
    modes: [
      { mode: 'native-resume', scope: 'same-home', verified: true },
      { mode: 'summary-continuation', scope: 'cross-device', verified: false },
    ],
    evidence: 'codex-session.service.ts: codex app-server model_provider="openai"',
    caveat: 'native-resume re-opens the thread on the same CODEX_HOME only.',
  },
  cursor: {
    provider: 'cursor',
    modes: [{ mode: 'summary-continuation', scope: 'cross-device', verified: false }],
    evidence: 'codex-session.service.ts: ACP session/new only — no session/load',
    caveat:
      'Cursor cannot resume a thread; a handoff starts a new session from a summary and prior context is omitted.',
  },
};

export function getProviderCapability(provider: AgentProvider): ProviderCapability {
  return PROVIDER_CAPABILITIES[provider];
}

/**
 * The best verified continuation mode for a provider, if any. Callers
 * must treat an undefined result as "cannot continue" — never fall back
 * to an unverified mode silently.
 */
export function bestVerifiedMode(
  provider: AgentProvider,
): ProviderMode | undefined {
  return PROVIDER_CAPABILITIES[provider].modes.find((m) => m.verified);
}

/** True only when a cross-device continuation mode is verified. */
export function supportsCrossDeviceResume(provider: AgentProvider): boolean {
  return PROVIDER_CAPABILITIES[provider].modes.some(
    (m) => m.scope === 'cross-device' && m.verified,
  );
}

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
 * until a second-home fixture proves import. The ACP providers (Cursor,
 * Devin) advertise `agentCapabilities.loadSession` at initialize (probed
 * live: cursor-agent acp, devin acp v3000.11.1) and `codex-session.service.ts`
 * sends ACP `session/load` when resuming a stored providerThreadId — so
 * same-home native resume is real for both. `session/load` cannot fork:
 * forking an ACP thread still produces a NEW provider thread, reported as
 * 'transcript-seeded' on the session's continuity field.
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
    modes: [
      { mode: 'native-resume', scope: 'same-home', verified: true },
      { mode: 'summary-continuation', scope: 'cross-device', verified: false },
    ],
    evidence:
      'codex-session.service.ts: ACP session/load gated on advertised agentCapabilities.loadSession (cursor-agent acp advertises loadSession: true)',
    caveat:
      'native-resume re-opens the session on the same device only; ACP cannot fork — forks start a new thread seeded from the transcript.',
  },
  devin: {
    provider: 'devin',
    modes: [
      { mode: 'native-resume', scope: 'same-home', verified: true },
      { mode: 'summary-continuation', scope: 'cross-device', verified: false },
    ],
    evidence:
      'codex-session.service.ts: ACP session/load gated on advertised agentCapabilities.loadSession (devin acp v3000.11.1 advertises loadSession: true)',
    caveat:
      'native-resume re-opens the session on the same device only; Devin mesh continuation has not been verified.',
  },
  llmgateway: {
    provider: 'llmgateway',
    modes: [{ mode: 'unsupported', scope: 'cross-device', verified: false }],
    evidence: 'codex-session.service.ts: local managed runtime; no verified mesh continuation',
    caveat: 'LLMGateway mesh continuation has not been verified.',
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
export function bestVerifiedMode(provider: AgentProvider): ProviderMode | undefined {
  return PROVIDER_CAPABILITIES[provider].modes.find((m) => m.verified);
}

/** True only when a cross-device continuation mode is verified. */
export function supportsCrossDeviceResume(provider: AgentProvider): boolean {
  return PROVIDER_CAPABILITIES[provider].modes.some(
    (m) => m.scope === 'cross-device' && m.verified,
  );
}

/** True when the provider can natively resume a stored provider thread on this device. */
export function supportsNativeResume(provider: AgentProvider): boolean {
  return PROVIDER_CAPABILITIES[provider].modes.some(
    (m) => m.mode === 'native-resume' && m.verified,
  );
}

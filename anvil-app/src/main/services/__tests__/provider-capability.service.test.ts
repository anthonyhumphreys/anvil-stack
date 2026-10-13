import { describe, expect, it } from 'vitest';
import {
  bestVerifiedMode,
  getAgentToolsCapability,
  getProviderCapability,
  supportsCrossDeviceResume,
} from '../provider-capability.service';
import type { AgentProvider } from '../../../shared/types';

const ALL: AgentProvider[] = ['azure', 'openai', 'codex', 'cursor', 'devin', 'llmgateway'];

describe('provider capability matrix (SESSION-01 audit)', () => {
  it('declares every AgentProvider — no silent gaps', () => {
    for (const p of ALL) {
      const cap = getProviderCapability(p);
      expect(cap.provider).toBe(p);
      expect(cap.modes.length).toBeGreaterThan(0);
      expect(cap.evidence).toContain('codex-session.service.ts');
    }
  });

  it('codex-protocol providers resume same-home only — not cross-device', () => {
    for (const p of ['codex', 'azure', 'openai'] as const) {
      const best = bestVerifiedMode(p);
      expect(best?.mode).toBe('native-resume');
      expect(best?.scope).toBe('same-home');
      // A provider thread id is not proof of portability.
      expect(supportsCrossDeviceResume(p)).toBe(false);
    }
  });

  it('cursor resumes same-home via ACP session/load — no cross-device claim', () => {
    const best = bestVerifiedMode('cursor');
    expect(best?.mode).toBe('native-resume');
    expect(best?.scope).toBe('same-home');
    expect(supportsCrossDeviceResume('cursor')).toBe(false);
  });

  it('Devin resumes via ACP session/load and LLMGateway via its managed Codex runtime', () => {
    const best = bestVerifiedMode('devin');
    expect(best?.mode).toBe('native-resume');
    expect(best?.scope).toBe('same-home');
    expect(supportsCrossDeviceResume('devin')).toBe(false);

    expect(getProviderCapability('llmgateway').provider).toBe('llmgateway');
    expect(bestVerifiedMode('llmgateway')?.mode).toBe('native-resume');
    expect(bestVerifiedMode('llmgateway')?.scope).toBe('same-home');
    expect(supportsCrossDeviceResume('llmgateway')).toBe(false);
  });

  it('no provider claims verified cross-device resume yet', () => {
    for (const p of ALL) {
      expect(supportsCrossDeviceResume(p)).toBe(false);
    }
  });

  it('declares an agent tools transport with evidence for every provider', () => {
    for (const p of ALL) {
      const tools = getProviderCapability(p).agentTools;
      expect(tools.transport).toBe('mcp-http');
      expect(tools.evidence).toContain('codex-session.service.ts');
    }
    expect(getProviderCapability('codex').agentTools.verified).toBe(true);
    expect(getProviderCapability('cursor').agentTools.verified).toBe(true);
    expect(getProviderCapability('devin').agentTools.verified).toBe(false);
    expect(getProviderCapability('llmgateway').agentTools.verified).toBe(false);
  });

  it('reports the stdio shim when an ACP agent does not advertise http, and fallback without an endpoint', () => {
    expect(getAgentToolsCapability('devin', { acpHttpAdvertised: false })).toMatchObject({
      transport: 'mcp-stdio-shim',
      verified: false,
    });
    expect(getAgentToolsCapability('codex', { acpHttpAdvertised: false }).transport).toBe(
      'mcp-http',
    );
    expect(getAgentToolsCapability('cursor', { endpointAvailable: false }).transport).toBe(
      'fallback',
    );
    expect(getAgentToolsCapability('cursor')).toBe(getProviderCapability('cursor').agentTools);
  });
});

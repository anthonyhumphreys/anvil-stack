import { describe, expect, it } from 'vitest';
import {
  bestVerifiedMode,
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

  it('devin resumes same-home via ACP session/load; llmgateway declares no verified mode', () => {
    const best = bestVerifiedMode('devin');
    expect(best?.mode).toBe('native-resume');
    expect(best?.scope).toBe('same-home');
    expect(supportsCrossDeviceResume('devin')).toBe(false);

    const gateway = getProviderCapability('llmgateway');
    expect(gateway.modes[0].mode).toBe('unsupported');
    expect(bestVerifiedMode('llmgateway')).toBeUndefined();
    expect(supportsCrossDeviceResume('llmgateway')).toBe(false);
  });

  it('no provider claims verified cross-device resume yet', () => {
    for (const p of ALL) {
      expect(supportsCrossDeviceResume(p)).toBe(false);
    }
  });
});

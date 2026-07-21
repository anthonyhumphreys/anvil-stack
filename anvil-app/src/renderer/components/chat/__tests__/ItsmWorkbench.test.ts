import { describe, expect, it } from 'vitest';
import { buildItsmContextPrompt, parseStoredItsmWorkbench } from '../ItsmWorkbench';

describe('buildItsmContextPrompt', () => {
  it('includes populated context and evidence guardrails', () => {
    const prompt = buildItsmContextPrompt('incident', 'Triage this incident.', {
      service: 'Payments API',
      impact: 'Checkout unavailable for UK customers',
      summary: '',
      evidence: 'HTTP 503 from 09:42 UTC',
      ownership: 'Alex, next update at 10:15 UTC',
    });

    expect(prompt).toContain('Record type: incident');
    expect(prompt).toContain('## Service or scope\nPayments API');
    expect(prompt).toContain('## Evidence and actions tried\nHTTP 503 from 09:42 UTC');
    expect(prompt).toContain('Do not claim that any action');
    expect(prompt).not.toContain('## Summary and timeline');
  });

  it('sanitises malformed persisted workbench data', () => {
    expect(
      parseStoredItsmWorkbench({
        recordType: 'definitely-a-ticket',
        context: { service: null, impact: 42, evidence: 'HTTP 503' },
      }),
    ).toEqual({
      recordType: 'incident',
      context: {
        service: '',
        impact: '',
        summary: '',
        evidence: 'HTTP 503',
        ownership: '',
      },
    });
  });
});

import { describe, expect, it } from 'vitest';
import { buildMeetingChatPath, parseMeetingNotes } from '../MeetingNotesView';

describe('parseMeetingNotes', () => {
  it('extracts summary sentences and action-looking items from raw notes', () => {
    const parsed = parseMeetingNotes(
      'We reviewed the billing migration. Alex will confirm the rollout plan. The new import flow is still ambiguous and needs a longer discussion with operations.',
    );

    expect(parsed.summary).toHaveLength(3);
    expect(parsed.actions).toEqual(['Alex will confirm the rollout plan.']);
    expect(parsed.spikeCandidates).toEqual([
      'The new import flow is still ambiguous and needs a longer discussion with operations.',
    ]);
    expect(parsed.keyPoints).toEqual([
      'The new import flow is still ambiguous and needs a longer discussion with operations.',
    ]);
  });

  it('flags risk, dependency, and research language as spike candidates', () => {
    const parsed = parseMeetingNotes(
      'Security review is still unclear. We need to investigate the vendor dependency. Sam will send notes.',
    );

    expect(parsed.spikeCandidates).toEqual([
      'Security review is still unclear.',
      'We need to investigate the vendor dependency.',
    ]);
    expect(parsed.actions).toEqual(['Sam will send notes.']);
  });
});

describe('buildMeetingChatPath', () => {
  it('passes meeting prompts through query params that ChatView consumes', () => {
    const path = buildMeetingChatPath('actions', 'Alice will follow up.');
    const url = new URL(path, 'app://anvil');

    expect(url.pathname).toBe('/chat');
    expect(url.searchParams.get('prompt')).toContain('Extract action items');
    expect(url.searchParams.get('prompt')).toContain('Alice will follow up.');
    expect(url.searchParams.has('persona')).toBe(false);
  });

  it('selects the BA persona for BA follow-ups', () => {
    const path = buildMeetingChatPath('ba', 'Long notes', 'Clarify scope');
    const url = new URL(path, 'app://anvil');

    expect(url.searchParams.get('persona')).toBe('ba');
    expect(url.searchParams.get('prompt')).toContain('Clarify scope');
  });

  it('selects the BA persona for spike assessment prompts', () => {
    const path = buildMeetingChatPath('spike', 'Long notes', 'Security is unclear');
    const url = new URL(path, 'app://anvil');

    expect(url.searchParams.get('persona')).toBe('ba');
    expect(url.searchParams.get('prompt')).toContain('Decide whether this needs a BA spike');
    expect(url.searchParams.get('prompt')).toContain('Security is unclear');
  });
});

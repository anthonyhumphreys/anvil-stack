import { describe, expect, it } from 'vitest';
import { ROLE_FEATURES, ROLE_RECOMMENDED_PERSONAS } from '../types';

describe('ITSM role', () => {
  it('keeps analysis and coordination tools without implementation surfaces', () => {
    expect(ROLE_FEATURES.itsm).toEqual(
      expect.arrayContaining([
        'repos',
        'chat',
        'workflows',
        'workitems',
        'security',
        'cicd',
        'docs',
        'governance',
        'meeting-notes',
        'workspace-notes',
      ]),
    );
    expect(ROLE_FEATURES.itsm).not.toEqual(
      expect.arrayContaining(['editor', 'automations', 'codereview', 'git', 'onboard']),
    );
  });

  it('recommends the full ITSM support and management persona set', () => {
    expect(ROLE_RECOMMENDED_PERSONAS.itsm).toEqual([
      'service-desk',
      'technical-support',
      'incident-manager',
      'problem-manager',
      'change-manager',
      'service-manager',
    ]);
  });
});

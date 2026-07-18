import { describe, expect, it } from 'vitest';
import type { Persona } from '../../../shared/types';
import { groupPersonasForRole } from '../persona-groups';

const persona = (id: string): Persona => ({
  id,
  name: id,
  icon: 'Code',
  colour: '#000000',
  description: id,
  systemPromptTemplate: `personas/${id}.md`,
  capabilities: { canWriteFiles: false, canRunCommands: false, canReadFiles: true },
});

describe('groupPersonasForRole', () => {
  it('puts ITSM recommendations first in their configured order', () => {
    const groups = groupPersonasForRole(
      [persona('coder'), persona('incident-manager'), persona('service-desk')],
      'itsm',
    );

    expect(groups[0]).toMatchObject({
      id: 'recommended',
      label: 'Recommended for ITSM',
    });
    expect(groups[0].personas.map(({ id }) => id)).toEqual(['service-desk', 'incident-manager']);
    expect(groups[1].personas.map(({ id }) => id)).toEqual(['coder']);
  });

  it('keeps a flat list and hides ITSM-only personas for other roles', () => {
    const personas = [persona('coder'), persona('service-desk'), persona('architect')];

    expect(groupPersonasForRole(personas, 'developer')).toEqual([
      {
        id: 'other',
        label: null,
        personas: [personas[0], personas[2]],
      },
    ]);
  });
});

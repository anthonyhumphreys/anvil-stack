import type { Persona, UserRole } from '../../shared/types';
import { ROLE_RECOMMENDED_PERSONAS } from '../../shared/types';

export interface PersonaGroup {
  id: 'recommended' | 'other';
  label: string | null;
  personas: Persona[];
}

export function groupPersonasForRole(personas: Persona[], role: UserRole): PersonaGroup[] {
  const itsmPersonaIds = ROLE_RECOMMENDED_PERSONAS.itsm ?? [];
  const recommendedIds = ROLE_RECOMMENDED_PERSONAS[role] ?? [];
  if (recommendedIds.length === 0) {
    const itsmPersonaSet = new Set(itsmPersonaIds);
    return [
      {
        id: 'other',
        label: null,
        personas: personas.filter((persona) => !itsmPersonaSet.has(persona.id)),
      },
    ];
  }

  const recommendedSet = new Set(recommendedIds);
  const recommended = recommendedIds
    .map((id) => personas.find((persona) => persona.id === id))
    .filter((persona): persona is Persona => Boolean(persona));
  const other = personas.filter((persona) => !recommendedSet.has(persona.id));

  return [
    { id: 'recommended', label: 'Recommended for ITSM', personas: recommended },
    { id: 'other', label: 'Other personas', personas: other },
  ].filter((group) => group.personas.length > 0);
}

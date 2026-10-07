import type { Persona } from '../../../shared/types';

/**
 * CH10 — persona picker recents. Stored renderer-side (localStorage); most
 * recently used personas float to a "Recent" group at the top of the picker.
 */

export const PERSONA_RECENTS_STORAGE_KEY = 'anvil:chat-persona-recents:v1';
export const PERSONA_RECENTS_LIMIT = 4;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadRecentPersonaIds(): string[] {
  const local = storage();
  if (!local) return [];
  try {
    const raw = local.getItem(PERSONA_RECENTS_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((id): id is string => typeof id === 'string')
      .slice(0, PERSONA_RECENTS_LIMIT);
  } catch {
    return [];
  }
}

/** Push `id` to the front of the recents list and persist. Returns the list. */
export function recordRecentPersonaId(id: string): string[] {
  const next = [id, ...loadRecentPersonaIds().filter((existing) => existing !== id)].slice(
    0,
    PERSONA_RECENTS_LIMIT,
  );
  const local = storage();
  if (local) {
    try {
      local.setItem(PERSONA_RECENTS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Non-fatal — recents are a convenience.
    }
  }
  return next;
}

/**
 * Split personas into a "Recent" group (in recency order, existing personas
 * only) and the remaining personas in their original order.
 */
export function splitPersonaRecents(
  personas: Persona[],
  recentIds: string[],
): { recent: Persona[]; rest: Persona[] } {
  const byId = new Map(personas.map((persona) => [persona.id, persona]));
  const recent = recentIds
    .map((id) => byId.get(id))
    .filter((persona): persona is Persona => Boolean(persona));
  const recentSet = new Set(recent.map((persona) => persona.id));
  return { recent, rest: personas.filter((persona) => !recentSet.has(persona.id)) };
}

/** Type-to-filter: matches persona name, id, and description. */
export function filterPersonas(personas: Persona[], query: string): Persona[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return personas;
  return personas.filter((persona) => {
    const haystack = `${persona.name}\n${persona.id}\n${persona.description ?? ''}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

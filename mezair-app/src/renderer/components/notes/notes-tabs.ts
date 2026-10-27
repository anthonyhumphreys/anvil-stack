import type { NotesTab } from '../../utils/sidebar-navigation';

/** The requested Notes tab if the role can use it, else the first allowed one. */
export function resolveNotesTab(
  requested: string | null,
  available: readonly NotesTab[],
): NotesTab | null {
  if (requested && (available as readonly string[]).includes(requested)) {
    return requested as NotesTab;
  }
  return available[0] ?? null;
}

// window.anvil.library — owned by the sidebar/Library workstream.
// Spec: docs/plans/inline-artifacts-and-canvas-tools.md §10 (Library).

export type LibraryItemKind = 'artifact' | 'surface' | 'adr' | 'diagram' | 'compliance' | 'doc';

export interface LibraryItem {
  id: string;
  kind: LibraryItemKind;
  /** Artifact kind or surface kind for icons/filtering. */
  subtype?: string;
  title: string;
  repoId?: string;
  threadId?: string;
  threadTitle?: string;
  path?: string;
  version?: number;
  shared?: boolean;
  updatedAt: string;
}

export interface LibraryApi {
  list(workspaceId: string, filter?: { kind?: LibraryItemKind; repoId?: string; query?: string }): Promise<LibraryItem[]>;
}

export interface WorkspaceTerminalState {
  activeRepoId: string | null;
  createdRepoIds: string[];
}

export const EMPTY_WORKSPACE_TERMINAL_STATE: WorkspaceTerminalState = {
  activeRepoId: null,
  createdRepoIds: [],
};

export function selectTerminalRepo(
  state: WorkspaceTerminalState,
  repoId: string,
): WorkspaceTerminalState {
  return {
    activeRepoId: repoId,
    createdRepoIds: state.createdRepoIds.includes(repoId)
      ? state.createdRepoIds
      : [...state.createdRepoIds, repoId],
  };
}

export function closeTerminalRepo(
  state: WorkspaceTerminalState,
  repoId: string,
): WorkspaceTerminalState {
  return {
    activeRepoId: state.activeRepoId,
    createdRepoIds: state.createdRepoIds.filter((id) => id !== repoId),
  };
}

import { Navigate, useSearchParams } from 'react-router-dom';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { validationInChatPath } from '../../utils/validation-in-chat';

/** Compatibility for saved evidence links. Validation is defined in chat. */
export function ChangeReviewView() {
  const [params] = useSearchParams();
  const { activeWorkspace } = useWorkspace();
  const repo =
    activeWorkspace?.repos.find((repo) => repo.id === params.get('repo')) ??
    activeWorkspace?.repos[0];
  return (
    <Navigate
      replace
      to={
        repo
          ? validationInChatPath(
              repo.id,
              params.get('review') ?? undefined,
              params.get('thread') ?? undefined,
            )
          : '/chat'
      }
    />
  );
}

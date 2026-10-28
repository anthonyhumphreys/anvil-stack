import type { PublicWorkflowRun, WorkflowRun } from '../../shared/types.js';

export function publicWorkflowRun(run: WorkflowRun): PublicWorkflowRun {
  const view = { ...run };
  delete view.remoteReviewCandidates;
  delete view.remoteReviewBackend;
  if (view.chatOrigin) {
    view.chatOrigin = { ...view.chatOrigin };
    delete view.chatOrigin.sourceBackend;
  }
  return view;
}

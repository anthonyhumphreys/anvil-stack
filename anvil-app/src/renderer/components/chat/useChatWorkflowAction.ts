import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ChatAttachment, WorkspaceWithRepos } from '../../../shared/types';
import {
  buildExecutionStrategyPrompt,
  type ExecutionStrategy,
} from '../../utils/execution-strategy';
import {
  hasExplicitWorkflowCommand,
  parseWorkflowChatIntent,
} from '../../utils/workflow-chat-intent';
import type { PendingWorkflowAction } from './ChatPromptOverlays';

/**
 * Workflow-intent interception for the composer — extracted from ChatView
 * (Phase 5 split). Messages that look like workflow commands get a
 * confirmation overlay before navigating to /workflows; everything else is
 * sent straight to the agent.
 */
export function useChatWorkflowAction({
  activeWorkspace,
  executionStrategy,
  fastMode,
  send,
  startNewSession,
}: {
  activeWorkspace: WorkspaceWithRepos | null | undefined;
  executionStrategy: ExecutionStrategy;
  fastMode: boolean;
  send: (
    message: string,
    attachments: ChatAttachment[],
    executionStrategyPrompt?: string,
    fastMode?: boolean,
  ) => Promise<void> | void;
  startNewSession: () => Promise<void> | void;
}) {
  const navigate = useNavigate();
  const [pendingWorkflowAction, setPendingWorkflowAction] = useState<PendingWorkflowAction | null>(
    null,
  );
  const [confirmingWorkflowAction, setConfirmingWorkflowAction] = useState(false);

  const handleComposerSend = useCallback(
    (message: string, attachments: ChatAttachment[] = []) => {
      if (attachments.length === 0 && message.trim().toLowerCase() === '/new') {
        void startNewSession();
        return;
      }

      const mayBeWorkflowIntent = hasExplicitWorkflowCommand(message);
      if (attachments.length === 0 && activeWorkspace && mayBeWorkflowIntent) {
        void window.anvil.workflow
          .listTemplates()
          .then((templates) => {
            const intent = parseWorkflowChatIntent(message, templates);
            if (!intent) {
              void send(
                message,
                attachments,
                buildExecutionStrategyPrompt(executionStrategy) ?? undefined,
                fastMode,
              );
              return;
            }
            setPendingWorkflowAction({
              message,
              intent,
              workspaceId: activeWorkspace.id,
              workspaceName: activeWorkspace.name,
              repoIds: activeWorkspace.repos.map((repo) => repo.id),
              executionStrategyPrompt: buildExecutionStrategyPrompt(executionStrategy) ?? undefined,
              fastMode,
            });
          })
          .catch(() => {
            void send(
              message,
              attachments,
              buildExecutionStrategyPrompt(executionStrategy) ?? undefined,
              fastMode,
            );
          });
        return;
      }

      void send(
        message,
        attachments,
        buildExecutionStrategyPrompt(executionStrategy) ?? undefined,
        fastMode,
      );
    },
    [activeWorkspace, executionStrategy, fastMode, send, startNewSession],
  );

  const confirmWorkflowAction = useCallback(async () => {
    if (!pendingWorkflowAction || confirmingWorkflowAction) return;
    setConfirmingWorkflowAction(true);
    try {
      const { intent } = pendingWorkflowAction;
      if (intent.kind === 'run') {
        const run = await window.anvil.workflow.startRun({
          templateId: intent.template.id,
          workspaceId: pendingWorkflowAction.workspaceId,
          repoIds: pendingWorkflowAction.repoIds,
          kickoff: intent.kickoff,
        });
        setPendingWorkflowAction(null);
        navigate(`/workflows?run=${encodeURIComponent(run.id)}`);
        return;
      }

      const params = new URLSearchParams({ kickoff: intent.kickoff });
      if (intent.kind === 'draft') params.set('draft', intent.request);
      setPendingWorkflowAction(null);
      navigate(`/workflows?${params.toString()}`);
    } catch {
      const pending = pendingWorkflowAction;
      setPendingWorkflowAction(null);
      await send(pending.message, [], pending.executionStrategyPrompt, pending.fastMode);
    } finally {
      setConfirmingWorkflowAction(false);
    }
  }, [confirmingWorkflowAction, navigate, pendingWorkflowAction, send]);

  const keepWorkflowPromptInChat = useCallback(() => {
    if (!pendingWorkflowAction || confirmingWorkflowAction) return;
    const pending = pendingWorkflowAction;
    setPendingWorkflowAction(null);
    void send(pending.message, [], pending.executionStrategyPrompt, pending.fastMode);
  }, [confirmingWorkflowAction, pendingWorkflowAction, send]);

  return {
    pendingWorkflowAction,
    confirmingWorkflowAction,
    handleComposerSend,
    confirmWorkflowAction,
    keepWorkflowPromptInChat,
  };
}

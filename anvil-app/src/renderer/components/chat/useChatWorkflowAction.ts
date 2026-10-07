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
  ) => Promise<boolean>;
  startNewSession: () => Promise<void> | void;
}) {
  const navigate = useNavigate();
  const [pendingWorkflowAction, setPendingWorkflowAction] = useState<PendingWorkflowAction | null>(
    null,
  );
  const [confirmingWorkflowAction, setConfirmingWorkflowAction] = useState(false);
  const [workflowActionError, setWorkflowActionError] = useState<string | null>(null);

  const handleComposerSend = useCallback(
    async (message: string, attachments: ChatAttachment[] = []): Promise<boolean> => {
      if (attachments.length === 0 && message.trim().toLowerCase() === '/new') {
        await startNewSession();
        return true;
      }
      const strategyPrompt = buildExecutionStrategyPrompt(executionStrategy) ?? undefined;
      if (attachments.length === 0 && activeWorkspace && hasExplicitWorkflowCommand(message)) {
        // Only discovery failures fall back to chat. A failed send must never be sent twice.
        const templates = await window.anvil.workflow.listTemplates().catch(() => null);
        const intent = templates ? parseWorkflowChatIntent(message, templates) : null;
        if (intent) {
          setWorkflowActionError(null);
          setPendingWorkflowAction({
            message,
            intent,
            workspaceId: activeWorkspace.id,
            workspaceName: activeWorkspace.name,
            repoIds: activeWorkspace.repos.map((repo) => repo.id),
            executionStrategyPrompt: strategyPrompt,
            fastMode,
          });
          return true;
        }
      }
      return send(message, attachments, strategyPrompt, fastMode);
    },
    [activeWorkspace, executionStrategy, fastMode, send, startNewSession],
  );

  const confirmWorkflowAction = useCallback(async () => {
    if (!pendingWorkflowAction || confirmingWorkflowAction) return;
    setConfirmingWorkflowAction(true);
    setWorkflowActionError(null);
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
      setWorkflowActionError(
        'The workflow request could not be confirmed. Check Workflows before trying again; it may already have started.',
      );
    } finally {
      setConfirmingWorkflowAction(false);
    }
  }, [confirmingWorkflowAction, navigate, pendingWorkflowAction]);

  const keepWorkflowPromptInChat = useCallback(async () => {
    if (!pendingWorkflowAction || confirmingWorkflowAction) return;
    const pending = pendingWorkflowAction;
    setConfirmingWorkflowAction(true);
    setWorkflowActionError(null);
    try {
      if (await send(pending.message, [], pending.executionStrategyPrompt, pending.fastMode)) {
        setPendingWorkflowAction(null);
      } else {
        setWorkflowActionError('The message was not accepted. Your workflow prompt is still here.');
      }
    } catch {
      setWorkflowActionError(
        'Delivery could not be confirmed. Check the conversation before sending again.',
      );
    } finally {
      setConfirmingWorkflowAction(false);
    }
  }, [confirmingWorkflowAction, pendingWorkflowAction, send]);

  return {
    pendingWorkflowAction,
    confirmingWorkflowAction,
    workflowActionError,
    handleComposerSend,
    confirmWorkflowAction,
    keepWorkflowPromptInChat,
  };
}

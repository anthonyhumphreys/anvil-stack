import { AlertTriangle, ClipboardList, MessageSquare } from 'lucide-react';
import { Button } from '../ui';
import { ChatEmptyState } from './ChatEmptyState';
import type { StarterPrompt } from '../../utils/starter-prompts';

/**
 * C4 / Phase 5 — one derived enum drives the chat pane's non-transcript
 * states instead of five independent inline conditionals in ChatView.
 */

export type ChatPaneKind =
  /** Chat is gated off (e.g. workspace not ready); shown above any content. */
  | 'blocked'
  /** Scaffold session is running and the thread is still empty. */
  | 'scaffold-intro'
  /** Tickets layout is active but no ticket has been picked. */
  | 'pick-work-item'
  /** Empty thread — persona-aware suggestions. */
  | 'empty-chat'
  /** Normal transcript. */
  | 'transcript';

export function deriveChatPaneState(input: {
  scaffoldModeActive: boolean;
  chatEnabled: boolean;
  isEmpty: boolean;
  hasError: boolean;
  isWorkItemLayout: boolean;
  activeThreadHasWorkItem: boolean;
}): ChatPaneKind {
  if (!input.scaffoldModeActive && !input.chatEnabled) return 'blocked';
  if (input.scaffoldModeActive && input.isEmpty && !input.hasError) return 'scaffold-intro';
  if (
    !input.scaffoldModeActive &&
    input.isWorkItemLayout &&
    !input.activeThreadHasWorkItem &&
    input.isEmpty &&
    !input.hasError
  ) {
    return 'pick-work-item';
  }
  if (!input.scaffoldModeActive && input.isEmpty && !input.hasError) return 'empty-chat';
  return 'transcript';
}

export function ChatPaneState({
  kind,
  scaffoldRootPath,
  blockedReason,
  onOpenWorkspace,
  personaId,
  hasRepos,
  hasGovernanceDocs,
  isDbExpertPersona,
  starterPrompts,
  onSuggestionClick,
}: {
  kind: ChatPaneKind;
  /** Root folder shown in the scaffold intro copy. */
  scaffoldRootPath?: string;
  /** Reason shown when kind === 'blocked'. */
  blockedReason?: string;
  /** J3: escape hatch from the blocked state toward the workspace surface. */
  onOpenWorkspace?: () => void;
  personaId: string;
  hasRepos: boolean;
  hasGovernanceDocs: boolean;
  isDbExpertPersona: boolean;
  /** C2 — repo-grounded prompts; the empty state falls back to persona sets. */
  starterPrompts?: StarterPrompt[];
  onSuggestionClick: (prompt: string) => void;
}) {
  switch (kind) {
    case 'blocked':
      return (
        <div className="flex items-center justify-center py-8">
          <div className="max-w-md text-center">
            <AlertTriangle size={24} className="mx-auto mb-2 text-warning" />
            <p className="text-base text-text-secondary">
              {blockedReason ?? 'Connect and index a repo first.'}
            </p>
            {onOpenWorkspace && (
              <Button variant="secondary" size="sm" className="mt-4" onClick={onOpenWorkspace}>
                Open workspace
              </Button>
            )}
          </div>
        </div>
      );

    case 'scaffold-intro':
      return (
        <div className="flex items-center justify-center py-8">
          <div className="max-w-xl text-center">
            <MessageSquare size={32} className="mx-auto mb-3 text-text-tertiary" />
            <p className="text-base text-text-secondary">
              Anvil is setting up your workspace in scaffold mode.
            </p>
            <p className="mt-2 text-sm text-text-tertiary">
              The coder persona will ask you to name the repositories it should create under{' '}
              <span className="font-mono text-text-secondary">
                {scaffoldRootPath ?? 'the selected root folder'}
              </span>
              .
            </p>
          </div>
        </div>
      );

    case 'pick-work-item':
      return (
        <div className="flex items-center justify-center py-8">
          <div className="max-w-md text-center">
            <ClipboardList size={32} className="mx-auto mb-3 text-text-tertiary" />
            <p className="text-base font-medium text-text-primary">Select a work item</p>
            <p className="mt-2 text-sm text-text-tertiary">
              Pick a ticket from the left. Its live and archived threads stay together.
            </p>
          </div>
        </div>
      );

    case 'empty-chat':
      return (
        <ChatEmptyState
          personaId={personaId}
          hasRepos={hasRepos}
          hasGovernanceDocs={hasGovernanceDocs}
          isDbExpertPersona={isDbExpertPersona}
          starterPrompts={starterPrompts}
          onSuggestionClick={onSuggestionClick}
        />
      );

    case 'transcript':
    default:
      return null;
  }
}

import { useCallback, useRef, useState, type ReactNode } from 'react';
import type {
  ReviewFinding,
  ReviewSurfaceData,
} from '../../../../../shared/surfaces/kinds/review/types';
import { formatFindingLocation } from '../../../../../shared/surfaces/kinds/review/model';
import { ConfirmDialog, PromptDialog } from '../../../ui';
import type { SurfaceViewProps } from '../../types';

export type ReviewAction =
  'accept' | 'dismiss' | 'reopen' | 'ask_fix' | 'apply_patch' | 'post_to_pr' | 'create_work_items';

type DialogState =
  | {
      kind: 'confirm';
      action: ReviewAction;
      ids: string[];
      title: string;
      description: string;
      confirmLabel: string;
    }
  | {
      kind: 'prompt';
      action: ReviewAction;
      ids: string[];
      title: string;
      description: string;
      label: string;
      placeholder: string;
      confirmLabel: string;
      required: boolean;
    };

export interface ReviewActionStatus {
  tone: 'ok' | 'error';
  text: string;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function describeTargets(findings: readonly ReviewFinding[]): string {
  if (findings.length === 1) return `${findings[0].title} (${formatFindingLocation(findings[0])})`;
  return plural(findings.length, 'finding');
}

/**
 * Runs Review actions through the host. Dismiss asks for a reason, ask-fix
 * takes an optional note, and mutations confirm first: the user's click plus
 * this confirm is the approval (spec §5.3).
 */
export function useReviewActions(
  data: ReviewSurfaceData | null,
  onAction: SurfaceViewProps['onAction'],
): {
  request: (action: ReviewAction, ids: string[]) => void;
  pending: ReviewAction | null;
  status: ReviewActionStatus | null;
  dialogOpen: boolean;
  dialogs: ReactNode;
} {
  const [pending, setPending] = useState<ReviewAction | null>(null);
  const [status, setStatus] = useState<ReviewActionStatus | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const inFlight = useRef(false);

  const execute = useCallback(
    async (action: ReviewAction, ids: string[], note?: string) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setPending(action);
      setStatus(null);
      try {
        const result = await onAction({ action, targetIds: ids, ...(note ? { note } : {}) });
        setStatus(
          result.ok
            ? { tone: 'ok', text: result.message ?? 'Done.' }
            : {
                tone: 'error',
                text: result.error ?? result.message ?? 'That action did not complete.',
              },
        );
      } catch (error) {
        setStatus({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
      } finally {
        inFlight.current = false;
        setPending(null);
      }
    },
    [onAction],
  );

  const request = useCallback(
    (action: ReviewAction, ids: string[]) => {
      if (!data) return;
      const findings = data.findings.filter((finding) => ids.includes(finding.id));
      switch (action) {
        case 'dismiss':
          if (!findings.length) return;
          setDialog({
            kind: 'prompt',
            action,
            ids,
            title: `Dismiss ${describeTargets(findings)}?`,
            description: 'The reason is kept with the review so the agent learns from it.',
            label: 'Reason',
            placeholder: 'e.g. Covered by the retry wrapper upstream',
            confirmLabel: 'Dismiss',
            required: true,
          });
          return;
        case 'ask_fix':
          if (!findings.length) return;
          setDialog({
            kind: 'prompt',
            action,
            ids,
            title: `Ask the agent to fix ${describeTargets(findings)}`,
            description: 'The agent continues in this thread and links its fix back to the review.',
            label: 'Note (optional)',
            placeholder: 'e.g. Keep the public API unchanged',
            confirmLabel: 'Send to agent',
            required: false,
          });
          return;
        case 'apply_patch': {
          const finding = findings[0];
          if (!finding) return;
          setDialog({
            kind: 'confirm',
            action,
            ids,
            title: 'Apply the suggested patch?',
            description: `Anvil checks the patch, then applies it to ${finding.filePath} in your working tree with git apply. You can review or revert it like any other change.`,
            confirmLabel: 'Apply patch',
          });
          return;
        }
        case 'post_to_pr':
          setDialog({
            kind: 'confirm',
            action,
            ids,
            title: `Post this review to PR #${data.scope.pullRequestId ?? ''}?`,
            description: `Posts one comment with the verdict and ${plural(
              ids.length ||
                data.findings.filter((f) => f.status !== 'dismissed' && f.status !== 'fixed')
                  .length,
              'finding',
            )}. Everyone with access to the pull request will see it.`,
            confirmLabel: 'Post to PR',
          });
          return;
        case 'create_work_items':
          if (!findings.length) return;
          setDialog({
            kind: 'confirm',
            action,
            ids,
            title: `Create ${plural(findings.length, 'work item')}?`,
            description:
              'Creates one item per finding in your connected work item tracker, linked back to this review.',
            confirmLabel: 'Create work items',
          });
          return;
        default:
          if (!ids.length) return;
          void execute(action, ids);
      }
    },
    [data, execute],
  );

  const close = () => setDialog(null);
  const dialogs = (
    <>
      <ConfirmDialog
        open={dialog?.kind === 'confirm'}
        title={dialog?.kind === 'confirm' ? dialog.title : ''}
        description={dialog?.kind === 'confirm' ? dialog.description : undefined}
        confirmLabel={dialog?.kind === 'confirm' ? dialog.confirmLabel : 'Confirm'}
        loading={pending !== null}
        onCancel={close}
        onConfirm={() => {
          if (dialog?.kind !== 'confirm') return;
          const { action, ids } = dialog;
          close();
          void execute(action, ids);
        }}
      />
      <PromptDialog
        open={dialog?.kind === 'prompt'}
        title={dialog?.kind === 'prompt' ? dialog.title : ''}
        description={dialog?.kind === 'prompt' ? dialog.description : undefined}
        label={dialog?.kind === 'prompt' ? dialog.label : undefined}
        placeholder={dialog?.kind === 'prompt' ? dialog.placeholder : undefined}
        confirmLabel={dialog?.kind === 'prompt' ? dialog.confirmLabel : 'Save'}
        allowEmpty={dialog?.kind === 'prompt' ? !dialog.required : false}
        onCancel={close}
        onSubmit={(value) => {
          if (dialog?.kind !== 'prompt') return;
          const { action, ids } = dialog;
          close();
          void execute(action, ids, value || undefined);
        }}
      />
    </>
  );

  return { request, pending, status, dialogOpen: dialog !== null, dialogs };
}

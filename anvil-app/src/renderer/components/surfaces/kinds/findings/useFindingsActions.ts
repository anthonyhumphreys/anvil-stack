import { useMemo } from 'react';
import type { SurfaceFinding } from '../../../../../shared/surfaces/kinds/findings';
import type { SurfaceViewProps } from '../../types';
import { useSurfaceActions } from '../../shared-ui/useSurfaceActions';
import { findingAnchor, type FindingsFilter } from './model';
import type { FindingActionHandlers } from './FindingParts';

export function useFindingsActions(props: SurfaceViewProps, findings: readonly SurfaceFinding[]) {
  const actions = useSurfaceActions(props.onAction);
  const { run, confirm, pending } = actions;
  const { onComment } = props;

  const handlers: FindingActionHandlers = useMemo(
    () => ({
      pending,
      onAskFix: (ids) => void run('ask_fix', ids),
      onDismiss: (ids) => void run('dismiss', ids),
      onCreateWorkItems: (ids) => {
        const eligible = findings.filter(
          (finding) => ids.includes(finding.id) && !finding.workItemId,
        );
        if (eligible.length === 0) return;
        confirm({
          action: 'create_work_items',
          targetIds: eligible.map((finding) => finding.id),
          title: `Create ${eligible.length} work item${eligible.length === 1 ? '' : 's'}?`,
          description:
            'Anvil will create items in your connected work item tracker and link them to these findings.',
          confirmLabel: 'Create work items',
        });
      },
      onComment: (finding) => onComment(findingAnchor(finding)),
    }),
    [pending, run, confirm, findings, onComment],
  );

  return { ...actions, handlers };
}

export type { FindingsFilter };

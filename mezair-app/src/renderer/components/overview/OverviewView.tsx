import { House } from 'lucide-react';
import { ViewHeader } from '../layout/ViewScaffold';
import { OverviewBoard, OverviewHeaderActions, overviewLayoutLabel } from './OverviewBoard';
import { useOverviewBoard } from './useOverviewBoard';

const GLOBAL_SCOPE = { kind: 'global' } as const;

/**
 * ANV-51: the all-workspaces overview at `/overview`. Every row keeps its
 * workspace label; opening one switches to that workspace first.
 */
export function OverviewView() {
  const board = useOverviewBoard(GLOBAL_SCOPE);

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-primary">
      <ViewHeader
        icon={House}
        eyebrow="All workspaces"
        title={board.editing ? 'Customise Home' : 'Home'}
        description={
          board.editing
            ? overviewLayoutLabel(board)
            : 'Everything across your workspaces. Open a workspace for its own overview.'
        }
        actions={<OverviewHeaderActions board={board} />}
      />
      <OverviewBoard board={board} />
    </div>
  );
}

import { House } from 'lucide-react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { ViewHeader } from '../layout/ViewScaffold';
import { OverviewBoard, OverviewHeaderActions, overviewLayoutLabel } from './OverviewBoard';
import { plural } from './overview-format';
import { useOverviewBoard } from './useOverviewBoard';

const GLOBAL_SCOPE = { kind: 'global' } as const;

/**
 * ANV-51: the all-workspaces overview at `/overview`. Every row keeps its
 * workspace label; opening one switches to that workspace first.
 */
export function OverviewView() {
  const { workspaces } = useWorkspace();
  const board = useOverviewBoard(GLOBAL_SCOPE);

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-primary">
      <ViewHeader
        icon={House}
        title={board.editing ? 'Customise overview' : 'All-workspaces overview'}
        description={
          board.editing
            ? `All workspaces · ${overviewLayoutLabel(board)}`
            : `Your personal view across ${plural(workspaces.length, 'workspace')}`
        }
        actions={<OverviewHeaderActions board={board} />}
      />
      <OverviewBoard board={board} />
    </div>
  );
}

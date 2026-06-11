import { Action, ActionPanel, Icon, List } from '@raycast/api';
import { useCachedPromise } from '@raycast/utils';
import { fetchOverview, openDesktop } from './api';
import { getExtensionBrand } from './brand';
import { ApprovalListItem } from './components';

export default function ApprovalsCommand() {
  const { data, isLoading, revalidate } = useCachedPromise(fetchOverview);
  const approvals = data?.pendingApprovals ?? [];
  const brand = getExtensionBrand();

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search pending approvals">
      {approvals.length === 0 ? (
        <List.EmptyView
          title="No pending approvals"
          description="Suspiciously peaceful."
          icon={Icon.CheckCircle}
          actions={
            <ActionPanel>
              <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={revalidate} />
              <Action
                title={`Open ${brand.appName}`}
                icon={Icon.AppWindow}
                onAction={() => void openDesktop()}
              />
            </ActionPanel>
          }
        />
      ) : (
        approvals.map((approval) => (
          <ApprovalListItem key={approval.requestKey} approval={approval} onResolved={revalidate} />
        ))
      )}
    </List>
  );
}

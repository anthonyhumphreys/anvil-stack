import { Action, ActionPanel, Icon, List, showToast, Toast } from '@raycast/api';
import { useCachedPromise } from '@raycast/utils';
import { fetchOverview, openDesktop, startWorkflow, type QuickAction } from './api';
import { getExtensionBrand } from './brand';
import { ApprovalListItem, SessionListItem } from './components';

export default function OverviewCommand() {
  const { data, isLoading, revalidate, error } = useCachedPromise(fetchOverview);
  const brand = getExtensionBrand();

  if (error) {
    void showToast({
      style: Toast.Style.Failure,
      title: `${brand.appName} unavailable`,
      message: error.message,
    });
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder={`Search ${brand.appName} status`}>
      <List.Section title="Command Deck">
        <List.Item
          title={data?.workflow.headline ?? `${brand.appName} unavailable`}
          subtitle={data?.workflow.detail ?? 'Check the companion base URL and token.'}
          icon={workflowIcon(data?.workflow.health)}
          accessories={[
            { text: `${data?.workflow.counts.pendingApprovals ?? 0} approvals` },
            { text: `${data?.workflow.counts.busySessions ?? 0} working` },
          ]}
          actions={
            <ActionPanel>
              <Action
                title={`Open ${brand.appName}`}
                icon={Icon.AppWindow}
                onAction={() => void openDesktop()}
              />
              <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={revalidate} />
            </ActionPanel>
          }
        />
        {(data?.quickActions ?? []).map((action) => (
          <QuickActionListItem key={action.id} action={action} onStarted={revalidate} />
        ))}
      </List.Section>

      <List.Section title="Workspace">
        <List.Item
          title={data?.activeWorkspace?.name ?? 'No active workspace'}
          subtitle={`${data?.activeWorkspace?.repos.length ?? 0} repos connected`}
          icon={Icon.Desktop}
          actions={
            <ActionPanel>
              <Action
                title={`Open ${brand.appName}`}
                icon={Icon.AppWindow}
                onAction={() => void openDesktop()}
              />
              <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={revalidate} />
            </ActionPanel>
          }
        />
      </List.Section>

      <List.Section title="Pending Approvals">
        {(data?.pendingApprovals ?? []).map((approval) => (
          <ApprovalListItem key={approval.requestKey} approval={approval} onResolved={revalidate} />
        ))}
        {data?.pendingApprovals.length === 0 && (
          <List.Item title="No pending approvals" icon={Icon.CheckCircle} />
        )}
      </List.Section>

      <List.Section title="Active Sessions">
        {(data?.activeSessions ?? []).map((session) => (
          <SessionListItem key={session.id} session={session} onChanged={revalidate} />
        ))}
        {data?.activeSessions.length === 0 && (
          <List.Item title="No active sessions" icon={Icon.Circle} />
        )}
      </List.Section>

      <List.Section title="Recent Chats">
        {(data?.threads ?? []).slice(0, 10).map((thread) => (
          <List.Item
            key={thread.id}
            title={thread.title}
            subtitle={thread.preview}
            icon={thread.activeSessionId ? Icon.Message : Icon.Text}
            accessories={[
              { text: thread.activeSessionStatus ?? `${thread.messageCount} messages` },
            ]}
          />
        ))}
      </List.Section>
    </List>
  );
}

function QuickActionListItem({
  action,
  onStarted,
}: {
  action: QuickAction;
  onStarted: () => void;
}) {
  const launch = async () => {
    await showToast({ style: Toast.Style.Animated, title: `Launching ${action.title}` });
    await startWorkflow({ actionId: action.id });
    onStarted();
    await showToast({ style: Toast.Style.Success, title: `${action.title} started` });
  };

  return (
    <List.Item
      title={action.title}
      subtitle={action.subtitle}
      icon={quickActionIcon(action.tone)}
      actions={
        <ActionPanel>
          <Action title="Launch Workflow" icon={Icon.Play} onAction={() => void launch()} />
          <Action.CopyToClipboard title="Copy Prompt" content={action.prompt} />
        </ActionPanel>
      }
    />
  );
}

function workflowIcon(health: string | undefined) {
  switch (health) {
    case 'needs-approval':
      return Icon.XMarkCircle;
    case 'busy':
      return Icon.CircleProgress;
    case 'ready':
      return Icon.CheckCircle;
    case 'idle':
      return Icon.Play;
    default:
      return Icon.Desktop;
  }
}

function quickActionIcon(tone: QuickAction['tone']) {
  switch (tone) {
    case 'green':
      return Icon.CheckCircle;
    case 'amber':
      return Icon.Document;
    case 'purple':
      return Icon.Document;
    case 'red':
      return Icon.XMarkCircle;
    case 'blue':
      return Icon.Text;
    default:
      return Icon.Play;
  }
}

import { Action, ActionPanel, Icon, List, showToast, Toast } from '@raycast/api';
import type { ApprovalRequest, ChatThread, CodexSession } from './api';
import { interruptSession, resolveApproval } from './api';

export function ApprovalActions({
  approval,
  onResolved,
}: {
  approval: ApprovalRequest;
  onResolved: () => void;
}) {
  const decide = async (decision: 'accept' | 'acceptForSession' | 'decline') => {
    await showToast({ style: Toast.Style.Animated, title: 'Resolving approval' });
    await resolveApproval(approval, decision);
    onResolved();
    await showToast({ style: Toast.Style.Success, title: 'Approval resolved' });
  };

  return (
    <ActionPanel.Section>
      <Action title="Approve" icon={Icon.CheckCircle} onAction={() => void decide('accept')} />
      <Action
        title="Approve Session"
        icon={Icon.CheckCircle}
        onAction={() => void decide('acceptForSession')}
      />
      <Action title="Decline" icon={Icon.XMarkCircle} onAction={() => void decide('decline')} />
    </ActionPanel.Section>
  );
}

export function ApprovalListItem({
  approval,
  onResolved,
}: {
  approval: ApprovalRequest;
  onResolved: () => void;
}) {
  const title =
    approval.kind === 'command'
      ? approval.command || 'Command approval'
      : approval.grantRoot || 'File change approval';
  return (
    <List.Item
      title={title}
      subtitle={approval.reason}
      icon={approval.kind === 'command' ? Icon.Terminal : Icon.Document}
      accessories={[{ text: new Date(approval.createdAt).toLocaleTimeString() }]}
      actions={
        <ActionPanel>
          <ApprovalActions approval={approval} onResolved={onResolved} />
        </ActionPanel>
      }
    />
  );
}

export function SessionListItem({
  session,
  onChanged,
}: {
  session: CodexSession;
  onChanged: () => void;
}) {
  const interrupt = async () => {
    await interruptSession(session.id);
    onChanged();
    await showToast({ style: Toast.Style.Success, title: 'Session interrupted' });
  };

  return (
    <List.Item
      title={`${session.personaId} session`}
      subtitle={session.id}
      icon={session.status === 'busy' ? Icon.CircleProgress : Icon.Circle}
      accessories={[{ text: session.status }]}
      actions={
        <ActionPanel>
          <Action
            title="Interrupt Session"
            icon={Icon.Stop}
            onAction={() => void interrupt()}
            shortcut={{ modifiers: ['cmd'], key: '.' }}
          />
        </ActionPanel>
      }
    />
  );
}

export function ThreadAccessory({ thread }: { thread: ChatThread }) {
  return (
    <List.Item.Detail.Metadata>
      <List.Item.Detail.Metadata.Label title="Persona" text={thread.personaId} />
      <List.Item.Detail.Metadata.Label title="Messages" text={String(thread.messageCount)} />
      <List.Item.Detail.Metadata.Label
        title="Pending approvals"
        text={String(thread.pendingApprovalCount)}
      />
      {thread.activeSessionStatus && (
        <List.Item.Detail.Metadata.Label title="Session" text={thread.activeSessionStatus} />
      )}
    </List.Item.Detail.Metadata>
  );
}

import { MaterialIcons } from '@react-native-vector-icons/material-icons';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import {
  ActionButton,
  EmptyState,
  SectionHeader,
  companionColors,
  monoStyle,
  screenStyle,
  scrollContentStyle,
} from '@/components/companion-ui';
import { useCompanion } from '@/contexts/companion-context';
import type { MobileApprovalRequest } from '../../../src/shared/types';

export default function InboxScreen() {
  const { overview, loading, refresh, resolve, openOnDesktop } = useCompanion();
  const approvals = overview?.pendingApprovals ?? [];
  const failed = overview?.activeSessions.filter((session) => session.status === 'error') ?? [];
  const count = approvals.length + failed.length;

  return (
    <ScrollView
      style={screenStyle}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} />}
      contentContainerStyle={scrollContentStyle}
    >
      <SectionHeader title="Needs attention" count={count} detail="Across all workspaces" />
      {count === 0 ? (
        <EmptyState
          title="Inbox clear"
          body="Approvals, blocked sessions, and failures will appear here."
        />
      ) : (
        <View style={{ gap: 10 }}>
          {approvals.map((approval) => (
            <ApprovalRow
              key={`${approval.sessionId}:${approval.requestKey}`}
              approval={approval}
              onDecision={(decision) => void resolve(approval, decision)}
              onDesktop={() => void openOnDesktop()}
            />
          ))}
          {failed.map((session) => (
            <View key={session.id} style={itemStyle}>
              <MaterialIcons name="error-outline" size={22} color={companionColors.red} />
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={itemTitleStyle}>{session.personaId} stopped</Text>
                <Text style={itemDetailStyle}>
                  The session ended with an error. Open the thread or inspect it on your Mac.
                </Text>
                <Tag
                  text={
                    session.workspaceId
                      ? workspaceName(overview?.workspaces ?? [], session.workspaceId)
                      : 'Unknown workspace'
                  }
                />
              </View>
              <ActionButton
                label="Mac"
                variant="secondary"
                onPress={() => void openOnDesktop()}
                style={{ minHeight: 44, paddingVertical: 8 }}
              />
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function ApprovalRow({
  approval,
  onDecision,
  onDesktop,
}: {
  approval: MobileApprovalRequest;
  onDecision: (decision: 'accept' | 'acceptForSession' | 'decline') => void;
  onDesktop: () => void;
}) {
  const desktopOnly = Boolean(approval.policy?.requiresFullReview);
  return (
    <View style={itemStyle}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <MaterialIcons
          name={approval.kind === 'command' ? 'terminal' : 'folder-open'}
          size={21}
          color={desktopOnly ? companionColors.red : companionColors.accentInk}
        />
        <View style={{ flex: 1 }}>
          <Text style={itemTitleStyle}>
            {approval.kind === 'command' ? 'Command approval' : 'File access'}
          </Text>
          <Text style={itemDetailStyle}>
            {approval.policy?.summary || approval.reason || 'Review requested'}
          </Text>
        </View>
      </View>
      <Text selectable style={monoStyle}>
        {approval.command || approval.grantRoot || 'Requested access'}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {approval.workspaceName && <Tag text={approval.workspaceName} />}
        {approval.repoName && <Tag text={approval.repoName} />}
        {approval.policy?.risk && (
          <Tag
            text={approval.policy.risk}
            danger={approval.policy.risk === 'high' || approval.policy.risk === 'destructive'}
          />
        )}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {desktopOnly ? (
          <ActionButton
            label="Review on Mac"
            variant="secondary"
            onPress={onDesktop}
            style={{ minHeight: 46 }}
          />
        ) : (
          <>
            <ActionButton
              label="Approve once"
              variant="success"
              onPress={() => onDecision('accept')}
              style={{ minHeight: 46, flexGrow: 1 }}
            />
            <ActionButton
              label="For session"
              variant="secondary"
              onPress={() => onDecision('acceptForSession')}
              style={{ minHeight: 46, flexGrow: 1 }}
            />
          </>
        )}
        <ActionButton
          label="Decline"
          variant="danger"
          onPress={() => onDecision('decline')}
          style={{ minHeight: 46 }}
        />
      </View>
    </View>
  );
}

function Tag({ text, danger = false }: { text: string; danger?: boolean }) {
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 8,
        backgroundColor: danger ? companionColors.redSoft : companionColors.surfaceMuted,
      }}
    >
      <Text
        style={{
          color: danger ? companionColors.red : companionColors.subtle,
          fontSize: 11,
          fontWeight: '800',
        }}
      >
        {text}
      </Text>
    </View>
  );
}

function workspaceName(workspaces: { id: string; name: string }[], id: string): string {
  return workspaces.find((workspace) => workspace.id === id)?.name ?? 'Unknown workspace';
}

const itemStyle = {
  padding: 14,
  gap: 12,
  borderRadius: 15,
  borderCurve: 'continuous' as const,
  borderWidth: 1,
  borderColor: companionColors.borderSubtle,
  backgroundColor: companionColors.surface,
};
const itemTitleStyle = { color: companionColors.ink, fontSize: 15, fontWeight: '900' as const };
const itemDetailStyle = { color: companionColors.muted, fontSize: 13, lineHeight: 18 };

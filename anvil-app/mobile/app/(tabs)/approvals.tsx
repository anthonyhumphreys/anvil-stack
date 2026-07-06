import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import {
  ActionButton,
  AttentionPanel,
  BlockedNotice,
  EmptyState,
  Panel,
  ScreenHeader,
  SignalGrid,
  SignalTile,
  StatusPill,
  bodyStyle,
  companionColors,
  monoStyle,
  screenStyle,
  scrollContentStyle,
  subtleStyle,
  titleStyle,
} from '@/components/companion-ui';
import { useCompanion } from '@/contexts/companion-context';
import type { CompanionApprovalRisk, MobileApprovalRequest } from '../../../src/shared/types';

export default function ApprovalsScreen() {
  const { overview, loading, refresh, resolve, openOnDesktop } = useCompanion();
  const approvals = overview?.pendingApprovals ?? [];
  const desktopOnlyCount = approvals.filter(
    (approval) => approval.policy?.requiresFullReview,
  ).length;
  const commandCount = approvals.filter((approval) => approval.kind === 'command').length;
  const highRiskCount = approvals.filter(
    (approval) => approval.policy?.risk === 'high' || approval.policy?.risk === 'destructive',
  ).length;
  const leadApproval =
    approvals.find((approval) => approval.policy?.requiresFullReview) ?? approvals[0];
  const attentionTone = desktopOnlyCount > 0 ? 'red' : approvals.length > 0 ? 'amber' : 'green';

  return (
    <ScrollView
      style={screenStyle}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} />}
      contentContainerStyle={scrollContentStyle}
    >
      <ScreenHeader eyebrow={`${approvals.length} pending`} title="Approvals" />

      <AttentionPanel
        label={desktopOnlyCount > 0 ? 'MAC REVIEW REQUIRED' : 'DECISION QUEUE'}
        title={approvalHeadline(approvals.length, desktopOnlyCount)}
        detail={
          leadApproval
            ? approvalSummary(leadApproval)
            : 'No commands or file grants are waiting on this device.'
        }
        tone={attentionTone}
        right={
          desktopOnlyCount > 0 ? (
            <ActionButton
              label="Open Mac"
              variant="secondary"
              onPress={openOnDesktop}
              style={{ paddingVertical: 8 }}
            />
          ) : undefined
        }
      />

      <SignalGrid>
        <SignalTile
          label="Pending"
          value={approvals.length}
          detail={approvals.length === 1 ? 'request' : 'requests'}
          tone={approvals.length > 0 ? 'amber' : 'green'}
        />
        <SignalTile
          label="Commands"
          value={commandCount}
          detail="terminal"
          tone={commandCount > 0 ? 'blue' : 'neutral'}
        />
        <SignalTile
          label="Desktop"
          value={desktopOnlyCount}
          detail={highRiskCount > 0 ? `${highRiskCount} high risk` : 'review'}
          tone={desktopOnlyCount > 0 ? 'red' : 'neutral'}
        />
      </SignalGrid>

      {approvals.length === 0 ? (
        <EmptyState title="Nothing waiting" body="No commands or file grants need a decision." />
      ) : (
        approvals.map((approval) => (
          <ApprovalCard
            key={`${approval.sessionId}:${approval.requestKey}`}
            approval={approval}
            onDecision={(decision) => resolve(approval, decision)}
          />
        ))
      )}
    </ScrollView>
  );
}

function ApprovalCard({
  approval,
  onDecision,
}: {
  approval: MobileApprovalRequest;
  onDecision: (decision: 'accept' | 'acceptForSession' | 'decline') => void;
}) {
  const isCommand = approval.kind === 'command';
  const policy = approval.policy;
  const riskTone = riskPillTone(policy?.risk);

  return (
    <Panel style={policy?.requiresFullReview ? desktopReviewPanelStyle : undefined}>
      <View style={cardHeaderStyle}>
        <View style={approvalIconStyle}>
          <MaterialIcons
            name={isCommand ? 'terminal' : 'folder-open'}
            size={18}
            color={companionColors.accentInk}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={titleStyle}>{isCommand ? 'Command' : 'File access'}</Text>
          <Text style={subtleStyle}>
            {approval.createdAt ? 'Pending decision' : 'Needs review'}
          </Text>
        </View>
        {policy?.risk && (
          <StatusPill
            label={policy.requiresFullReview ? `${policy.risk} / desktop` : policy.risk}
            color={riskTone.color}
            background={riskTone.background}
          />
        )}
      </View>

      <Text selectable style={monoStyle}>
        {isCommand ? approval.command || 'Command requested' : approval.grantRoot || 'File change'}
      </Text>

      {policy?.summary && (
        <Text selectable style={bodyStyle}>
          {policy.summary}
        </Text>
      )}
      {approval.reason && (
        <Text selectable style={bodyStyle}>
          {approval.reason}
        </Text>
      )}
      {approval.cwd && (
        <Text selectable style={subtleStyle}>
          cwd: {approval.cwd}
        </Text>
      )}
      {approval.repoName && (
        <Text selectable style={subtleStyle}>
          repo: {approval.repoName}
        </Text>
      )}
      {policy?.blockedReason && (
        <Text selectable style={[subtleStyle, { color: companionColors.red }]}>
          {policy.blockedReason}
        </Text>
      )}

      {policy?.requiresFullReview && (
        <BlockedNotice body="Review on Mac before approving. Mobile can decline this request, not bless it." />
      )}

      <View style={buttonGridStyle}>
        {!policy?.requiresFullReview && (
          <>
            <ActionButton
              label="Approve once"
              variant="success"
              onPress={() => onDecision('accept')}
              style={{ flexGrow: 1 }}
            />
            <ActionButton
              label="For session"
              variant="secondary"
              onPress={() => onDecision('acceptForSession')}
              style={{ flexGrow: 1 }}
            />
          </>
        )}
        <ActionButton
          label="Decline"
          variant="danger"
          onPress={() => onDecision('decline')}
          style={{ flexGrow: 1 }}
        />
      </View>
    </Panel>
  );
}

function riskPillTone(risk?: CompanionApprovalRisk) {
  if (risk === 'low') {
    return { color: companionColors.green, background: companionColors.greenSoft };
  }
  if (risk === 'medium') {
    return { color: companionColors.accentInk, background: companionColors.accentSoft };
  }
  return { color: companionColors.red, background: companionColors.redSoft };
}

function approvalHeadline(total: number, desktopOnlyCount: number): string {
  if (total === 0) return 'Clear';
  if (desktopOnlyCount > 0) {
    return `${desktopOnlyCount} ${desktopOnlyCount === 1 ? 'request needs' : 'requests need'} the Mac`;
  }
  return `${total} ${total === 1 ? 'request' : 'requests'} can be decided here`;
}

function approvalSummary(approval: MobileApprovalRequest): string {
  const target =
    approval.kind === 'command'
      ? approval.command || 'Command requested'
      : approval.grantRoot || 'File access requested';
  const repo = approval.repoName ? ` / ${approval.repoName}` : '';
  const risk = approval.policy?.risk ? `${approval.policy.risk} risk / ` : '';
  return `${risk}${target}${repo}`;
}

const cardHeaderStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 12,
};
const desktopReviewPanelStyle = {
  borderColor: companionColors.redBorder,
  backgroundColor: companionColors.redSoft,
};
const approvalIconStyle = {
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  width: 38,
  height: 38,
  borderRadius: 10,
  backgroundColor: companionColors.accentSoft,
};
const buttonGridStyle = {
  flexDirection: 'row' as const,
  flexWrap: 'wrap' as const,
  gap: 8,
  marginTop: 4,
};

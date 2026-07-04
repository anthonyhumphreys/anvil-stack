import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import {
  ActionButton,
  EmptyState,
  Panel,
  ScreenHeader,
  StatusPill,
  bodyStyle,
  companionColors,
  screenStyle,
  scrollContentStyle,
  subtleStyle,
  titleStyle,
} from '@/components/companion-ui';
import { useCompanion } from '@/contexts/companion-context';
import type { CompanionApprovalRisk, MobileApprovalRequest } from '../../../src/shared/types';

export default function ApprovalsScreen() {
  const { overview, loading, refresh, resolve } = useCompanion();
  const approvals = overview?.pendingApprovals ?? [];

  return (
    <ScrollView
      style={screenStyle}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} />}
      contentContainerStyle={scrollContentStyle}
    >
      <ScreenHeader
        eyebrow="Permission queue"
        title="Approvals"
        detail="Approve the narrow thing, approve the session, or decline before a local agent treats a local workflow like production."
      />

      {approvals.length === 0 ? (
        <EmptyState
          title="Nothing waiting"
          body="No pending Codex approvals. Suspiciously peaceful."
        />
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
    <Panel>
      <View style={cardHeaderStyle}>
        <View style={approvalIconStyle}>
          <MaterialIcons
            name={isCommand ? 'terminal' : 'folder-open'}
            size={18}
            color={companionColors.accentInk}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={titleStyle}>{isCommand ? 'Command approval' : 'File change approval'}</Text>
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

      <View style={buttonGridStyle}>
        <ActionButton
          label="Approve"
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

const cardHeaderStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 12,
};
const approvalIconStyle = {
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  width: 38,
  height: 38,
  borderRadius: 10,
  backgroundColor: companionColors.accentSoft,
};
const monoStyle = {
  color: companionColors.ink,
  fontFamily: 'Menlo',
  fontSize: 13,
  backgroundColor: companionColors.surfaceMuted,
  borderColor: companionColors.borderSubtle,
  borderWidth: 1,
  padding: 10,
  borderRadius: 10,
};
const buttonGridStyle = {
  flexDirection: 'row' as const,
  flexWrap: 'wrap' as const,
  gap: 8,
  marginTop: 4,
};

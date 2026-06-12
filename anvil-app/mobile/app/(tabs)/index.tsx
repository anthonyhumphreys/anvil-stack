import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import type { ComponentProps } from 'react';
import { RefreshControl, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import {
  ActionButton,
  EmptyState,
  Panel,
  ScreenHeader,
  SectionHeader,
  StatusPill,
  bodyStyle,
  companionColors,
  screenStyle,
  scrollContentStyle,
  subtleStyle,
  titleStyle,
} from '@/components/companion-ui';
import { useCompanion } from '@/contexts/companion-context';
import type {
  CodexSession,
  MobileQuickAction,
  MobileWorkflowHealth,
} from '../../../src/shared/types';

type IconName = ComponentProps<typeof MaterialIcons>['name'];

const HEALTH_COPY: Record<
  MobileWorkflowHealth,
  { label: string; color: string; background: string; icon: IconName }
> = {
  'needs-approval': {
    label: 'Needs approval',
    color: companionColors.red,
    background: companionColors.redSoft,
    icon: 'priority-high',
  },
  busy: {
    label: 'Working',
    color: companionColors.blue,
    background: companionColors.blueSoft,
    icon: 'bolt',
  },
  ready: {
    label: 'Ready',
    color: companionColors.green,
    background: companionColors.greenSoft,
    icon: 'check-circle',
  },
  idle: {
    label: 'Ready to launch',
    color: companionColors.muted,
    background: '#f2f4f7',
    icon: 'play-arrow',
  },
  unconfigured: {
    label: 'Setup needed',
    color: companionColors.accentInk,
    background: companionColors.accentSoft,
    icon: 'settings',
  },
};

const ACTION_ICONS: Record<string, IconName> = {
  'status-sweep': 'radar',
  'review-diff': 'rate-review',
  'test-hunt': 'science',
  'ship-handoff': 'rocket-launch',
};

export default function OverviewScreen() {
  const {
    connection,
    overview,
    loading,
    live,
    lastUpdatedAt,
    error,
    refresh,
    openOnDesktop,
    startWorkflow,
    interrupt,
  } = useCompanion();
  const workflow = overview?.workflow;
  const health = HEALTH_COPY[workflow?.health ?? 'unconfigured'];
  const activeSessions = overview?.activeSessions ?? [];
  const approvals = overview?.pendingApprovals ?? [];
  const recentThreads = overview?.threads ?? [];

  return (
    <ScrollView
      style={screenStyle}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} />}
      contentContainerStyle={scrollContentStyle}
    >
      <ScreenHeader
        eyebrow="Anvil companion"
        title="Command deck"
        detail={connection ? connection.baseUrl : 'Pair your Mac to launch and steer local agents.'}
        right={<StatusPill label={health.label} color={health.color} background={health.background} />}
      />

      {connection && (
        <View style={connectionBarStyle}>
          <MaterialIcons
            name={live ? 'wifi-tethering' : 'sync'}
            size={16}
            color={live ? companionColors.green : companionColors.subtle}
          />
          <Text style={connectionTextStyle}>
            {live ? 'Live event stream' : 'Polling desktop'}
            {lastUpdatedAt ? ` / ${new Date(lastUpdatedAt).toLocaleTimeString()}` : ''}
          </Text>
        </View>
      )}

      {error && (
        <Panel tone="danger">
          <Text selectable style={{ color: companionColors.red, fontWeight: '800' }}>
            {error}
          </Text>
        </Panel>
      )}

      <Panel tone="dark" style={heroPanelStyle}>
        <View style={heroHeaderStyle}>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={darkEyebrowStyle}>Active workspace</Text>
            <Text style={workspaceTitleStyle}>
              {overview?.activeWorkspace?.name ?? 'No active workspace'}
            </Text>
          </View>
          <View style={heroStatusIconStyle}>
            <MaterialIcons name={health.icon} size={18} color={health.color} />
          </View>
        </View>
        <Text style={heroHeadlineStyle}>{workflow?.headline ?? 'Pair Anvil on your Mac'}</Text>
        <Text style={heroDetailStyle}>
          {workflow?.detail ??
            'Enable Mobile Companion in desktop Settings, then scan the pairing code.'}
        </Text>
        <View style={metricGridStyle}>
          <MetricChip label="Approvals" value={workflow?.counts?.pendingApprovals ?? 0} />
          <MetricChip label="Working" value={workflow?.counts?.busySessions ?? 0} />
          <MetricChip label="Repos" value={workflow?.counts?.workspaceRepos ?? 0} />
        </View>
      </Panel>

      {connection && (
        <View style={buttonRowStyle}>
          <ActionButton label="Open Mac" onPress={openOnDesktop} style={{ flex: 1 }} />
          <ActionButton label="Refresh" variant="secondary" onPress={refresh} />
        </View>
      )}

      <View style={sectionStyle}>
        <SectionHeader
          title="Launch"
          detail="Start useful agent work without opening the desktop app."
        />
        <View style={quickActionGridStyle}>
          {(overview?.quickActions ?? []).map((action) => (
            <QuickActionButton
              key={action.id}
              action={action}
              disabled={!connection || loading}
              onPress={() => void startWorkflow({ actionId: action.id })}
            />
          ))}
        </View>
        {!connection && (
          <EmptyState
            title="Pair before launching"
            body="Remote launches need a local Anvil desktop session to drive."
          />
        )}
      </View>

      <View style={sectionStyle}>
        <SectionHeader title="Approvals" count={approvals.length} />
        {approvals.slice(0, 3).map((approval) => (
          <Panel key={`${approval.sessionId}:${approval.requestKey}`}>
            <Text numberOfLines={1} style={titleStyle}>
              {approval.kind === 'command'
                ? approval.command || 'Command approval'
                : approval.grantRoot || 'File change approval'}
            </Text>
            <Text numberOfLines={2} style={bodyStyle}>
              {approval.reason || approval.cwd || 'Codex needs a decision.'}
            </Text>
          </Panel>
        ))}
        {approvals.length === 0 && (
          <EmptyState title="Nothing waiting" body="No approvals are blocking sessions right now." />
        )}
      </View>

      <View style={sectionStyle}>
        <SectionHeader title="Active sessions" count={activeSessions.length} />
        {activeSessions.map((session) => (
          <SessionRow key={session.id} session={session} onInterrupt={() => interrupt(session.id)} />
        ))}
        {activeSessions.length === 0 && (
          <EmptyState
            title="No running sessions"
            body="Launch a workflow above when the Mac is paired."
          />
        )}
      </View>

      <View style={sectionStyle}>
        <SectionHeader title="Recent threads" count={recentThreads.length} />
        {recentThreads.slice(0, 5).map((thread) => (
          <Panel key={thread.id}>
            <Text numberOfLines={1} style={titleStyle}>
              {thread.title}
            </Text>
            <Text numberOfLines={2} style={bodyStyle}>
              {thread.preview || `${thread.personaId} thread`}
            </Text>
          </Panel>
        ))}
        {recentThreads.length === 0 && (
          <EmptyState title="No recent chats" body="Threads will appear here after desktop work starts." />
        )}
      </View>
    </ScrollView>
  );
}

function MetricChip({ label, value }: { label: string; value: number }) {
  return (
    <View style={metricChipStyle}>
      <Text style={metricLabelStyle}>{label}</Text>
      <Text style={metricValueStyle}>{value}</Text>
    </View>
  );
}

function QuickActionButton({
  action,
  disabled,
  onPress,
}: {
  action: MobileQuickAction;
  disabled: boolean;
  onPress: () => void;
}) {
  const tone = ACTION_TONES[action.tone] ?? ACTION_TONES.neutral;
  const icon = ACTION_ICONS[action.id] ?? 'auto-awesome';
  return (
    <TouchableOpacity
      disabled={disabled}
      onPress={onPress}
      style={[
        quickActionStyle,
        {
          borderColor: tone.border,
          backgroundColor: tone.background,
          opacity: disabled ? 0.55 : 1,
        },
      ]}
    >
      <View style={[actionIconStyle, { backgroundColor: tone.iconBackground }]}>
        <MaterialIcons name={icon} size={18} color={tone.text} />
      </View>
      <Text numberOfLines={1} style={[titleStyle, { color: tone.text }]}>
        {action.title}
      </Text>
      <Text numberOfLines={2} style={subtleStyle}>
        {action.subtitle}
      </Text>
    </TouchableOpacity>
  );
}

function SessionRow({
  session,
  onInterrupt,
}: {
  session: CodexSession;
  onInterrupt: () => Promise<void>;
}) {
  const busy = session.status === 'busy' || session.status === 'starting';
  return (
    <Panel>
      <View style={sessionRowStyle}>
        <View style={{ flex: 1, gap: 3 }}>
          <Text numberOfLines={1} style={titleStyle}>
            {session.personaId} session
          </Text>
          <Text numberOfLines={1} style={bodyStyle}>
            {session.status} / {session.mode ?? 'on-request'}
          </Text>
        </View>
        <ActionButton
          label="Stop"
          variant="danger"
          disabled={!busy}
          onPress={() => void onInterrupt()}
          style={{ paddingVertical: 8 }}
        />
      </View>
    </Panel>
  );
}

const ACTION_TONES = {
  neutral: {
    background: companionColors.surface,
    border: companionColors.borderSubtle,
    text: companionColors.ink,
    iconBackground: companionColors.surfaceMuted,
  },
  blue: {
    background: companionColors.blueSoft,
    border: '#b2ddff',
    text: companionColors.blue,
    iconBackground: '#d1e9ff',
  },
  green: {
    background: companionColors.greenSoft,
    border: '#abefc6',
    text: companionColors.green,
    iconBackground: '#dcfae6',
  },
  amber: {
    background: companionColors.accentSoft,
    border: '#fedf89',
    text: companionColors.accentInk,
    iconBackground: '#ffead5',
  },
  red: {
    background: companionColors.redSoft,
    border: '#fecdca',
    text: companionColors.red,
    iconBackground: '#fee4e2',
  },
  purple: {
    background: companionColors.purpleSoft,
    border: '#d9d6fe',
    text: companionColors.purple,
    iconBackground: '#ebe9fe',
  },
};

const connectionBarStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 8,
  borderRadius: 10,
  borderWidth: 1,
  borderColor: companionColors.borderSubtle,
  backgroundColor: companionColors.surface,
  paddingHorizontal: 12,
  paddingVertical: 10,
};
const connectionTextStyle = {
  flex: 1,
  color: companionColors.subtle,
  fontSize: 13,
  fontWeight: '700' as const,
};
const heroPanelStyle = { gap: 12 };
const heroHeaderStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  justifyContent: 'space-between' as const,
  gap: 12,
};
const darkEyebrowStyle = {
  color: companionColors.darkMuted,
  fontSize: 12,
  fontWeight: '800' as const,
};
const workspaceTitleStyle = {
  color: '#fcfcfd',
  fontSize: 16,
  fontWeight: '900' as const,
};
const heroStatusIconStyle = {
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  width: 36,
  height: 36,
  borderRadius: 10,
  backgroundColor: '#1f2937',
};
const heroHeadlineStyle = {
  color: '#fcfcfd',
  fontSize: 28,
  fontWeight: '900' as const,
  lineHeight: 32,
};
const heroDetailStyle = {
  color: companionColors.darkMuted,
  fontSize: 15,
  lineHeight: 22,
};
const metricGridStyle = { flexDirection: 'row' as const, gap: 8, flexWrap: 'wrap' as const };
const metricChipStyle = {
  backgroundColor: '#1f2937',
  borderRadius: 10,
  paddingHorizontal: 12,
  paddingVertical: 9,
  minWidth: 88,
};
const metricLabelStyle = {
  color: companionColors.darkMuted,
  fontSize: 12,
  fontWeight: '700' as const,
};
const metricValueStyle = {
  color: '#fcfcfd',
  fontSize: 18,
  fontWeight: '900' as const,
};
const buttonRowStyle = { flexDirection: 'row' as const, gap: 10 };
const sectionStyle = { gap: 10 };
const quickActionGridStyle = {
  flexDirection: 'row' as const,
  flexWrap: 'wrap' as const,
  gap: 10,
};
const quickActionStyle = {
  flexGrow: 1,
  flexBasis: '47%' as const,
  minHeight: 132,
  borderWidth: 1,
  borderRadius: 10,
  padding: 12,
  gap: 8,
};
const actionIconStyle = {
  width: 34,
  height: 34,
  borderRadius: 9,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
};
const sessionRowStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  justifyContent: 'space-between' as const,
  gap: 12,
};

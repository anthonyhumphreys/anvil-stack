import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useMemo, useState, type ComponentProps } from 'react';
import { RefreshControl, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import {
  ActionButton,
  EmptyState,
  Panel,
  ScreenHeader,
  SectionHeader,
  StatusPill,
  bodyStyle,
  companionColors,
  inputStyle,
  screenStyle,
  scrollContentStyle,
  subtleStyle,
  titleStyle,
} from '@/components/companion-ui';
import { useCompanion } from '@/contexts/companion-context';
import type {
  CodexSession,
  MobileApprovalRequest,
  MobileQuickAction,
  MobileStartChatInput,
  MobileWorkQueueItem,
  MobileWorkflowHealth,
  RepoInfo,
} from '../../../src/shared/types';
import type { CompanionConnection } from '@/lib/anvil-api';

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

export default function WorkScreen() {
  const {
    connection,
    connections,
    overview,
    loading,
    live,
    lastUpdatedAt,
    error,
    refresh,
    selectHost,
    openOnDesktop,
    startWorkflow,
    interrupt,
    resolve,
  } = useCompanion();
  const [draft, setDraft] = useState('');
  const [planFirst, setPlanFirst] = useState(true);
  const [selectedRepoIds, setSelectedRepoIds] = useState<string[]>([]);
  const [launchingActionId, setLaunchingActionId] = useState<string | null>(null);

  const workflow = overview?.workflow;
  const health = HEALTH_COPY[workflow?.health ?? 'unconfigured'];
  const activeWorkspace = overview?.activeWorkspace;
  const repos = useMemo(() => activeWorkspace?.repos ?? [], [activeWorkspace?.repos]);
  const availableRepoIds = useMemo(() => new Set(repos.map((repo) => repo.id)), [repos]);
  const effectiveSelectedRepoIds = selectedRepoIds.filter((repoId) => availableRepoIds.has(repoId));
  const launchRepoIds =
    effectiveSelectedRepoIds.length > 0 ? effectiveSelectedRepoIds : repos.map((repo) => repo.id);
  const workQueue = overview?.workQueue ?? [];
  const approvals = overview?.pendingApprovals ?? [];
  const activeSessions = overview?.activeSessions ?? [];
  const quickActions = overview?.quickActions ?? [];
  const canLaunch = Boolean(connection && activeWorkspace && launchRepoIds.length > 0);

  const launchInput = (
    input: Omit<MobileStartChatInput, 'workspaceId' | 'repoIds'>,
  ): MobileStartChatInput => ({
    ...input,
    workspaceId: activeWorkspace?.id,
    repoIds: launchRepoIds,
    collaborationMode: planFirst ? 'plan' : 'default',
  });

  const launchDraft = async () => {
    if (!draft.trim() || !canLaunch) return;
    const message = draft.trim();
    setLaunchingActionId('custom');
    try {
      const result = await startWorkflow(
        launchInput({
          message,
          title: titleFromMessage(message),
          personaId: 'coder',
        }),
      );
      if (result) setDraft('');
    } finally {
      setLaunchingActionId(null);
    }
  };

  const launchQuickAction = async (action: MobileQuickAction) => {
    if (!canLaunch) return;
    setLaunchingActionId(action.id);
    try {
      await startWorkflow(launchInput({ actionId: action.id }));
    } finally {
      setLaunchingActionId(null);
    }
  };

  const toggleRepo = (repoId: string) => {
    setSelectedRepoIds((current) => {
      const selected = current.length > 0 ? current.filter((id) => availableRepoIds.has(id)) : [];
      if (selected.length === 0) return [repoId];
      const next = selected.includes(repoId)
        ? selected.filter((candidate) => candidate !== repoId)
        : [...selected, repoId];
      return next.length === 0 || next.length === repos.length ? [] : next;
    });
  };

  return (
    <ScrollView
      style={screenStyle}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} />}
      contentContainerStyle={scrollContentStyle}
    >
      <ScreenHeader
        eyebrow="Anvil companion"
        title="Work"
        detail={
          connection ? hostDetail(connection) : 'Pair your Mac to launch and steer local agents.'
        }
        right={
          <StatusPill label={health.label} color={health.color} background={health.background} />
        }
      />

      {connection && (
        <View style={connectionBarStyle}>
          <MaterialIcons
            name={live ? 'wifi-tethering' : 'sync'}
            size={16}
            color={live ? companionColors.green : companionColors.subtle}
          />
          <Text style={connectionTextStyle}>
            {live ? 'Live from host' : 'Polling host'}
            {lastUpdatedAt ? ` / ${new Date(lastUpdatedAt).toLocaleTimeString()}` : ''}
          </Text>
          <ActionButton
            label="Open Mac"
            variant="secondary"
            onPress={openOnDesktop}
            style={{ paddingVertical: 8 }}
          />
        </View>
      )}

      {error && (
        <Panel tone="danger">
          <Text selectable style={{ color: companionColors.red, fontWeight: '800' }}>
            {error}
          </Text>
        </Panel>
      )}

      {connections.length > 1 && (
        <View style={sectionStyle}>
          <SectionHeader title="Hosts" detail="Pick the desktop that owns this run." />
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={hostRailStyle}
          >
            {connections.map((host) => (
              <HostChip
                key={host.id}
                host={host}
                active={host.id === connection?.id}
                onPress={() => void selectHost(host.id)}
              />
            ))}
          </ScrollView>
        </View>
      )}

      <Panel tone="dark" style={launchPanelStyle}>
        <View style={launchHeaderStyle}>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={darkEyebrowStyle}>Active workspace</Text>
            <Text style={workspaceTitleStyle}>
              {activeWorkspace?.name ?? 'No active workspace'}
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
          <MetricChip label="Needs you" value={workflow?.counts?.pendingApprovals ?? 0} />
          <MetricChip label="Working" value={workflow?.counts?.busySessions ?? 0} />
          <MetricChip label="Repos" value={workflow?.counts?.workspaceRepos ?? 0} />
        </View>

        <View style={modeRowStyle}>
          <ModeButton active={planFirst} label="Plan" onPress={() => setPlanFirst(true)} />
          <ModeButton active={!planFirst} label="Execute" onPress={() => setPlanFirst(false)} />
        </View>

        {repos.length > 0 && (
          <RepoPicker
            repos={repos}
            selectedRepoIds={effectiveSelectedRepoIds}
            onSelectAll={() => setSelectedRepoIds([])}
            onToggleRepo={toggleRepo}
          />
        )}

        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="Ask Anvil to review, test, investigate, or prepare a handoff..."
          placeholderTextColor="#98a2b3"
          multiline
          style={darkInputStyle}
        />
        <ActionButton
          label={
            launchingActionId === 'custom' ? 'Launching...' : planFirst ? 'Start plan' : 'Start run'
          }
          onPress={() => void launchDraft()}
          disabled={!draft.trim() || !canLaunch || Boolean(launchingActionId)}
          style={{ backgroundColor: companionColors.accent, borderColor: companionColors.accent }}
          textStyle={{ color: companionColors.dark }}
        />
      </Panel>

      <View style={sectionStyle}>
        <SectionHeader
          title="Quick starts"
          detail="Plan-first by default; execute only when you mean it."
        />
        <View style={quickActionGridStyle}>
          {quickActions.map((action) => (
            <QuickActionButton
              key={action.id}
              action={action}
              disabled={!canLaunch || Boolean(launchingActionId)}
              loading={launchingActionId === action.id}
              onPress={() => void launchQuickAction(action)}
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
        <SectionHeader title="Work queue" count={workQueue.length} />
        {workQueue.length > 0 ? (
          workQueue.map((item) => (
            <WorkQueueCard
              key={item.id}
              item={item}
              approval={findApproval(item, approvals)}
              session={findSession(item, activeSessions)}
              onResolve={(approval, decision) => void resolve(approval, decision)}
              onInterrupt={(sessionId) => void interrupt(sessionId)}
              onOpenDesktop={openOnDesktop}
            />
          ))
        ) : (
          <EmptyState
            title="Nothing active"
            body="Start a plan, kick off a review, or enjoy the suspicious calm."
          />
        )}
      </View>
    </ScrollView>
  );
}

function HostChip({
  host,
  active,
  onPress,
}: {
  host: CompanionConnection;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      disabled={active}
      onPress={onPress}
      style={[hostChipStyle, active && activeHostChipStyle]}
    >
      <MaterialIcons
        name={active ? 'radio-button-checked' : 'computer'}
        size={17}
        color={active ? companionColors.green : companionColors.subtle}
      />
      <View style={{ gap: 2, maxWidth: 190 }}>
        <Text numberOfLines={1} style={hostTitleStyle}>
          {host.deviceName || hostLabel(host.baseUrl)}
        </Text>
        <Text numberOfLines={1} style={hostUrlStyle}>
          {hostLabel(host.baseUrl)}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

function RepoPicker({
  repos,
  selectedRepoIds,
  onSelectAll,
  onToggleRepo,
}: {
  repos: RepoInfo[];
  selectedRepoIds: string[];
  onSelectAll: () => void;
  onToggleRepo: (repoId: string) => void;
}) {
  const allSelected = selectedRepoIds.length === 0;
  return (
    <View style={repoPickerStyle}>
      <Text style={darkEyebrowStyle}>Launch target</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={repoRailStyle}
      >
        <TouchableOpacity
          onPress={onSelectAll}
          style={[repoChipStyle, allSelected && selectedRepoChipStyle]}
        >
          <MaterialIcons name="select-all" size={16} color={allSelected ? '#fcfcfd' : '#98a2b3'} />
          <Text style={[repoChipTextStyle, allSelected && selectedRepoChipTextStyle]}>
            All repos
          </Text>
        </TouchableOpacity>
        {repos.map((repo) => {
          const selected = allSelected || selectedRepoIds.includes(repo.id);
          return (
            <TouchableOpacity
              key={repo.id}
              onPress={() => onToggleRepo(repo.id)}
              style={[repoChipStyle, selected && selectedRepoChipStyle]}
            >
              <MaterialIcons
                name={selected ? 'check-circle' : 'folder'}
                size={16}
                color={selected ? '#fcfcfd' : '#98a2b3'}
              />
              <Text
                numberOfLines={1}
                style={[repoChipTextStyle, selected && selectedRepoChipTextStyle]}
              >
                {repo.name || repo.path}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

function ModeButton({
  active,
  label,
  onPress,
}: {
  active: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity onPress={onPress} style={[modeButtonStyle, active && activeModeButtonStyle]}>
      <Text style={[modeButtonTextStyle, active && activeModeButtonTextStyle]}>{label}</Text>
    </TouchableOpacity>
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
  loading,
  onPress,
}: {
  action: MobileQuickAction;
  disabled: boolean;
  loading: boolean;
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
        <MaterialIcons name={loading ? 'hourglass-top' : icon} size={18} color={tone.text} />
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

function WorkQueueCard({
  item,
  approval,
  session,
  onResolve,
  onInterrupt,
  onOpenDesktop,
}: {
  item: MobileWorkQueueItem;
  approval?: MobileApprovalRequest;
  session?: CodexSession;
  onResolve: (
    approval: MobileApprovalRequest,
    decision: 'accept' | 'acceptForSession' | 'decline',
  ) => void;
  onInterrupt: (sessionId: string) => void;
  onOpenDesktop: () => void;
}) {
  const tone = QUEUE_TONES[item.priority];
  const busy = session?.status === 'busy' || session?.status === 'starting';

  return (
    <Panel>
      <View style={queueHeaderStyle}>
        <View style={[queueIconStyle, { backgroundColor: tone.background }]}>
          <MaterialIcons name={queueIcon(item)} size={18} color={tone.color} />
        </View>
        <View style={{ flex: 1, gap: 3 }}>
          <View style={queueTitleRowStyle}>
            <Text numberOfLines={1} style={titleStyle}>
              {item.title}
            </Text>
            <StatusPill label={item.statusLabel} color={tone.color} background={tone.background} />
          </View>
          <Text numberOfLines={2} style={bodyStyle}>
            {item.detail}
          </Text>
        </View>
      </View>

      <View style={metadataRowStyle}>
        {item.repoName && <MetadataChip icon="folder" label={item.repoName} />}
        {item.workspaceName && <MetadataChip icon="workspaces" label={item.workspaceName} />}
        {item.risk && <MetadataChip icon="shield" label={`Risk: ${item.risk}`} />}
        <MetadataChip icon="schedule" label={relativeTime(item.updatedAt)} />
      </View>

      {approval && (
        <ApprovalDetail approval={approval} requiresDesktopReview={item.requiresDesktopReview} />
      )}

      <View style={queueActionRowStyle}>
        {approval && !item.requiresDesktopReview && (
          <>
            <ActionButton
              label="Approve"
              variant="success"
              onPress={() => onResolve(approval, 'accept')}
              style={{ flexGrow: 1 }}
            />
            <ActionButton
              label="Decline"
              variant="danger"
              onPress={() => onResolve(approval, 'decline')}
              style={{ flexGrow: 1 }}
            />
          </>
        )}
        {approval && item.requiresDesktopReview && (
          <ActionButton
            label="Review on Mac"
            variant="secondary"
            onPress={onOpenDesktop}
            style={{ flexGrow: 1 }}
          />
        )}
        {item.kind === 'session' && item.sessionId && (
          <ActionButton
            label={busy ? 'Interrupt' : 'Open Mac'}
            variant={busy ? 'danger' : 'secondary'}
            onPress={() => (busy ? onInterrupt(item.sessionId!) : onOpenDesktop())}
            style={{ flexGrow: 1 }}
          />
        )}
        {item.kind === 'thread' && (
          <ActionButton
            label="Open Mac"
            variant="secondary"
            onPress={onOpenDesktop}
            style={{ flexGrow: 1 }}
          />
        )}
      </View>
    </Panel>
  );
}

function ApprovalDetail({
  approval,
  requiresDesktopReview,
}: {
  approval: MobileApprovalRequest;
  requiresDesktopReview?: boolean;
}) {
  const policy = approval.policy;
  return (
    <View style={approvalDetailStyle}>
      <Text selectable style={monoStyle}>
        {approval.kind === 'command'
          ? approval.command || 'Command requested'
          : approval.grantRoot || 'File change'}
      </Text>
      {policy?.requestedAction && (
        <Text style={subtleStyle}>Requested: {policy.requestedAction}</Text>
      )}
      {requiresDesktopReview && (
        <Text style={[subtleStyle, { color: companionColors.red }]}>
          {policy?.blockedReason ?? 'Requires desktop review before approval.'}
        </Text>
      )}
    </View>
  );
}

function MetadataChip({ icon, label }: { icon: IconName; label: string }) {
  return (
    <View style={metadataChipStyle}>
      <MaterialIcons name={icon} size={14} color={companionColors.subtle} />
      <Text numberOfLines={1} style={metadataTextStyle}>
        {label}
      </Text>
    </View>
  );
}

function findApproval(
  item: MobileWorkQueueItem,
  approvals: MobileApprovalRequest[],
): MobileApprovalRequest | undefined {
  if (item.kind !== 'approval' || !item.sessionId || !item.requestKey) return undefined;
  return approvals.find(
    (approval) => approval.sessionId === item.sessionId && approval.requestKey === item.requestKey,
  );
}

function findSession(
  item: MobileWorkQueueItem,
  sessions: CodexSession[],
): CodexSession | undefined {
  if (!item.sessionId) return undefined;
  return sessions.find((session) => session.id === item.sessionId);
}

function queueIcon(item: MobileWorkQueueItem): IconName {
  if (item.kind === 'approval') return item.requiresDesktopReview ? 'desktop-windows' : 'verified';
  if (item.kind === 'session') return 'bolt';
  return 'forum';
}

function titleFromMessage(message: string): string {
  const trimmed = message.replace(/\s+/g, ' ').trim();
  return trimmed.length > 44 ? `${trimmed.slice(0, 41)}...` : trimmed || 'Remote prompt';
}

function hostDetail(connection: CompanionConnection): string {
  return `${connection.deviceName || 'Selected host'} / ${hostLabel(connection.baseUrl)}`;
}

function hostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function relativeTime(value: string): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return 'Just now';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'Just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
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

const QUEUE_TONES: Record<MobileWorkQueueItem['priority'], { color: string; background: string }> =
  {
    critical: { color: companionColors.red, background: companionColors.redSoft },
    high: { color: companionColors.accentInk, background: companionColors.accentSoft },
    normal: { color: companionColors.blue, background: companionColors.blueSoft },
    low: { color: companionColors.subtle, background: companionColors.surfaceMuted },
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
const sectionStyle = { gap: 10 };
const hostRailStyle = { gap: 8, paddingRight: 4 };
const hostChipStyle = {
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
const activeHostChipStyle = {
  borderColor: '#abefc6',
  backgroundColor: companionColors.greenSoft,
};
const hostTitleStyle = {
  color: companionColors.ink,
  fontSize: 14,
  fontWeight: '900' as const,
};
const hostUrlStyle = {
  color: companionColors.subtle,
  fontSize: 12,
  fontWeight: '700' as const,
};
const launchPanelStyle = { gap: 12 };
const launchHeaderStyle = {
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
const modeRowStyle = {
  flexDirection: 'row' as const,
  borderWidth: 1,
  borderColor: '#475467',
  borderRadius: 10,
  padding: 3,
  backgroundColor: '#1d2939',
};
const modeButtonStyle = {
  flex: 1,
  alignItems: 'center' as const,
  borderRadius: 8,
  paddingVertical: 9,
};
const activeModeButtonStyle = { backgroundColor: '#fcfcfd' };
const modeButtonTextStyle = {
  color: companionColors.darkMuted,
  fontSize: 14,
  fontWeight: '900' as const,
};
const activeModeButtonTextStyle = { color: companionColors.dark };
const repoPickerStyle = { gap: 8 };
const repoRailStyle = { gap: 8, paddingRight: 4 };
const repoChipStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 6,
  maxWidth: 190,
  minHeight: 38,
  borderRadius: 999,
  borderWidth: 1,
  borderColor: '#475467',
  backgroundColor: '#1d2939',
  paddingHorizontal: 12,
  paddingVertical: 8,
};
const selectedRepoChipStyle = {
  borderColor: '#fcfcfd',
  backgroundColor: '#344054',
};
const repoChipTextStyle = {
  color: '#98a2b3',
  fontSize: 13,
  fontWeight: '800' as const,
  maxWidth: 150,
};
const selectedRepoChipTextStyle = { color: '#fcfcfd' };
const darkInputStyle = {
  ...inputStyle,
  minHeight: 96,
  backgroundColor: '#1d2939',
  borderColor: '#475467',
  color: '#fcfcfd',
  textAlignVertical: 'top' as const,
};
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
const queueHeaderStyle = {
  flexDirection: 'row' as const,
  alignItems: 'flex-start' as const,
  gap: 12,
};
const queueIconStyle = {
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  width: 38,
  height: 38,
  borderRadius: 10,
};
const queueTitleRowStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 8,
};
const metadataRowStyle = {
  flexDirection: 'row' as const,
  flexWrap: 'wrap' as const,
  gap: 6,
};
const metadataChipStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 5,
  borderRadius: 999,
  borderWidth: 1,
  borderColor: companionColors.borderSubtle,
  backgroundColor: companionColors.surfaceMuted,
  paddingHorizontal: 9,
  paddingVertical: 5,
  maxWidth: 220,
};
const metadataTextStyle = {
  color: companionColors.subtle,
  fontSize: 12,
  fontWeight: '800' as const,
  maxWidth: 170,
};
const approvalDetailStyle = { gap: 7 };
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
const queueActionRowStyle = {
  flexDirection: 'row' as const,
  flexWrap: 'wrap' as const,
  gap: 8,
  marginTop: 2,
};

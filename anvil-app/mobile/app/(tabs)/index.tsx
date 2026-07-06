import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { router, type RelativePathString } from 'expo-router';
import { useMemo, useState, type ComponentProps } from 'react';
import { RefreshControl, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import {
  ActionButton,
  AttentionPanel,
  EmptyState,
  Panel,
  ScreenHeader,
  SectionHeader,
  SignalGrid,
  SignalTile,
  StatusPill,
  bodyStyle,
  companionColors,
  inputStyle,
  monoStyle,
  screenStyle,
  scrollContentStyle,
  subtleStyle,
  titleStyle,
  type CompanionColor,
} from '@/components/companion-ui';
import { useCompanion } from '@/contexts/companion-context';
import type {
  AgentRunStatus,
  AgentRunSummary,
  CodexSession,
  MobileApprovalRequest,
  MobileQuickAction,
  MobileStartChatInput,
  MobileWorkQueueItem,
  MobileWorkspaceSignal,
  MobileWorkflowHealth,
  RepoInfo,
} from '../../../src/shared/types';
import type { CompanionConnection } from '@/lib/anvil-api';

type IconName = ComponentProps<typeof MaterialIcons>['name'];

const HEALTH_COPY: Record<
  MobileWorkflowHealth,
  { label: string; color: CompanionColor; background: CompanionColor; icon: IconName }
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
    background: companionColors.surfaceMuted,
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
  const recentRuns = overview?.recentRuns ?? [];
  const workspaceHealth = overview?.workspaceHealth;
  const canLaunch = Boolean(connection && activeWorkspace && launchRepoIds.length > 0);
  const topQueueItem = workQueue[0];
  const attentionTone = workflow ? healthTone(workflow.health) : 'amber';
  const primaryActionLabel =
    approvals.length > 0
      ? 'Review'
      : topQueueItem?.threadId
        ? 'Open thread'
        : connection
          ? 'Open Mac'
          : 'Pair';
  const primaryAction = () => {
    if (approvals.length > 0) {
      router.navigate('/(tabs)/approvals');
      return;
    }
    if (topQueueItem?.threadId) {
      router.push(threadHref(topQueueItem.threadId));
      return;
    }
    if (connection) {
      void openOnDesktop();
      return;
    }
    router.navigate('/(tabs)/settings');
  };

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
        eyebrow={activeWorkspace?.name ?? 'No workspace'}
        title="Home"
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

      <AttentionPanel
        label={live ? 'LIVE COMPANION' : connection ? 'COMPANION' : 'SETUP'}
        title={homeHeadline(workflow?.headline, topQueueItem)}
        detail={
          homeDetail(workflow?.detail, activeWorkspace?.name, topQueueItem) ??
          'Scan the desktop pairing QR, then use this phone for approvals, handoffs, and quick starts.'
        }
        tone={attentionTone}
        right={
          <ActionButton
            label={primaryActionLabel}
            variant={approvals.length > 0 ? 'danger' : 'secondary'}
            onPress={primaryAction}
            style={{ paddingVertical: 8 }}
          />
        }
      >
        {topQueueItem ? (
          <TouchableOpacity
            activeOpacity={0.76}
            onPress={() =>
              topQueueItem.kind === 'approval'
                ? router.navigate('/(tabs)/approvals')
                : topQueueItem.threadId
                  ? router.push(threadHref(topQueueItem.threadId))
                  : router.navigate('/(tabs)/chats')
            }
            style={nextActionStyle}
          >
            <View style={nextActionIconStyle}>
              <MaterialIcons
                name={queueIcon(topQueueItem)}
                size={17}
                color={companionColors.ink}
              />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text numberOfLines={1} style={nextActionTitleStyle}>
                {topQueueItem.title}
              </Text>
              <Text numberOfLines={1} style={nextActionDetailStyle}>
                {topQueueItem.statusLabel} / {relativeTime(topQueueItem.updatedAt)}
              </Text>
            </View>
            <MaterialIcons name="chevron-right" size={20} color={companionColors.subtle} />
          </TouchableOpacity>
        ) : (
          <View style={nextActionStyle}>
            <View style={nextActionIconStyle}>
              <MaterialIcons name="done-all" size={17} color={companionColors.green} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={nextActionTitleStyle}>Clear</Text>
              <Text style={nextActionDetailStyle}>
                Launch a run, resume a thread, or leave it alone.
              </Text>
            </View>
          </View>
        )}
      </AttentionPanel>

      <SignalGrid>
        <SignalTile
          label="Needs"
          value={workflow?.counts?.pendingApprovals ?? 0}
          detail={approvals.length > 0 ? 'decisions' : 'clear'}
          tone={approvals.length > 0 ? 'red' : 'green'}
          onPress={() => router.navigate('/(tabs)/approvals')}
        />
        <SignalTile
          label="Running"
          value={workflow?.counts?.busySessions ?? 0}
          detail={activeSessions.length > 0 ? 'in progress' : 'idle'}
          tone={activeSessions.length > 0 ? 'blue' : 'neutral'}
        />
        <SignalTile
          label="Threads"
          value={workflow?.counts?.recentThreads ?? overview?.threads.length ?? 0}
          detail="recent"
          tone="cyan"
          onPress={() => router.navigate('/(tabs)/chats')}
        />
      </SignalGrid>

      <View style={sectionStyle}>
        <SectionHeader title="Workspace health" />
        <SignalGrid>
          <SignalTile
            label="Review"
            value={workspaceHealth?.reviewFindingCount ?? 0}
            detail="findings"
            tone={(workspaceHealth?.reviewFindingCount ?? 0) > 0 ? 'amber' : 'green'}
          />
          <SignalTile
            label="Security"
            value={workspaceHealth?.securityFindingCount ?? 0}
            detail={
              (workspaceHealth?.criticalCount ?? 0) > 0
                ? `${workspaceHealth?.criticalCount} critical`
                : 'findings'
            }
            tone={(workspaceHealth?.securityFindingCount ?? 0) > 0 ? 'red' : 'green'}
          />
          <SignalTile
            label="Work"
            value={(workspaceHealth?.lifecycleItemCount ?? 0) + (workspaceHealth?.workItemCount ?? 0)}
            detail="tracked"
            tone={(workspaceHealth?.lifecycleItemCount ?? 0) > 0 ? 'purple' : 'neutral'}
          />
        </SignalGrid>
        {workspaceHealth?.signals.length ? (
          workspaceHealth.signals.slice(0, 4).map((signal) => (
            <WorkspaceSignalCard
              key={signal.id}
              signal={signal}
              onPress={() => router.push(healthSignalHref(signal.id))}
            />
          ))
        ) : (
          <EmptyState
            title="No open signals"
            body={
              activeWorkspace
                ? 'No review findings, security findings, or tracked work need attention.'
                : 'Pair a Mac and choose a workspace to load health signals.'
            }
          />
        )}
      </View>

      {error && (
        <Panel tone="danger">
          <Text selectable style={{ color: companionColors.red, fontWeight: '800' }}>
            {error}
          </Text>
        </Panel>
      )}

      {connections.length > 1 && (
        <View style={sectionStyle}>
          <SectionHeader title="Hosts" />
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
            <Text style={darkEyebrowStyle}>COMMAND</Text>
            <Text style={workspaceTitleStyle}>
              {activeWorkspace?.name ?? 'Choose a workspace on Mac'}
            </Text>
          </View>
          <View style={heroStatusIconStyle}>
            <MaterialIcons name={health.icon} size={18} color={health.color} />
          </View>
        </View>

        <View style={consoleStripStyle}>
          <ConsoleFact label="Mode" value={planFirst ? 'Plan first' : 'Execute'} />
          <ConsoleFact
            label="Scope"
            value={
              launchRepoIds.length === repos.length
                ? 'All repos'
                : `${launchRepoIds.length} repo${launchRepoIds.length === 1 ? '' : 's'}`
            }
          />
          <ConsoleFact
            label="Queue"
            value={`${workQueue.length} item${workQueue.length === 1 ? '' : 's'}`}
          />
        </View>

        {canLaunch ? (
          <>
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
              placeholder="Review the current diff, find risk, write the next step..."
              placeholderTextColor={companionColors.darkMuted}
              multiline
              style={darkInputStyle}
            />
            <ActionButton
              label={
                launchingActionId === 'custom'
                  ? 'Launching...'
                  : planFirst
                    ? 'Start plan'
                    : 'Start run'
              }
              onPress={() => void launchDraft()}
              disabled={!draft.trim() || Boolean(launchingActionId)}
              style={{ backgroundColor: companionColors.accent, borderColor: companionColors.accent }}
              textStyle={{ color: companionColors.dark }}
            />
          </>
        ) : (
          <View style={setupNoticeStyle}>
            <MaterialIcons
              name={connection ? 'workspaces' : 'qr-code-scanner'}
              size={19}
              color={companionColors.accent}
            />
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={setupNoticeTitleStyle}>
                {connection ? 'Choose a workspace on Mac' : 'Pair a Mac first'}
              </Text>
              <Text style={setupNoticeBodyStyle}>
                {connection
                  ? 'Remote runs need an active workspace with at least one repo.'
                  : 'Pairing unlocks chat, reviews, approvals, widgets, and handoff actions.'}
              </Text>
            </View>
            <ActionButton
              label={connection ? 'Open Mac' : 'Settings'}
              variant="secondary"
              onPress={() =>
                connection ? void openOnDesktop() : router.navigate('/(tabs)/settings')
              }
              style={{ paddingVertical: 8 }}
            />
          </View>
        )}
      </Panel>

      <View style={sectionStyle}>
        <SectionHeader title="Quick starts" />
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
        {!connection && <EmptyState title="No host" body="Pair a Mac in Settings." />}
      </View>

      <View style={sectionStyle}>
        <SectionHeader title="Recent work" count={recentRuns.length} />
        {recentRuns.length > 0 ? (
          recentRuns.slice(0, 6).map((run) => (
            <ActivityRunCard
              key={run.id}
              run={run}
              onOpenThread={(threadId) => router.push(threadHref(threadId))}
              onOpenDesktop={openOnDesktop}
            />
          ))
        ) : (
          <EmptyState
            title="No runs yet"
            body={
              activeWorkspace
                ? 'Start a review, security sweep, or chat run from this phone.'
                : 'Choose a workspace on the Mac first.'
            }
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
              onOpenThread={(threadId) => router.push(threadHref(threadId))}
            />
          ))
        ) : (
          <EmptyState title="Clear" body="No active runs or pending decisions." />
        )}
      </View>
    </ScrollView>
  );
}

function ActivityRunCard({
  run,
  onOpenThread,
  onOpenDesktop,
}: {
  run: AgentRunSummary;
  onOpenThread: (threadId: string) => void;
  onOpenDesktop: () => void;
}) {
  const tone = RUN_STATUS_TONES[run.status];
  const source = runSource(run);

  return (
    <TouchableOpacity
      activeOpacity={0.78}
      onPress={() => (run.threadId ? onOpenThread(run.threadId) : onOpenDesktop())}
      style={activityRunStyle}
    >
      <View style={[activityIconStyle, { backgroundColor: source.background }]}>
        <MaterialIcons name={source.icon} size={18} color={source.color} />
      </View>
      <View style={{ flex: 1, gap: 5 }}>
        <View style={activityRunTopStyle}>
          <Text numberOfLines={1} style={[titleStyle, { flex: 1 }]}>
            {run.title}
          </Text>
          <StatusPill
            label={runStatusLabel(run.status)}
            color={tone.color}
            background={tone.background}
          />
        </View>
        {run.summary && (
          <Text numberOfLines={2} style={bodyStyle}>
            {run.summary}
          </Text>
        )}
        <View style={activityMetaRowStyle}>
          <MetadataChip icon={source.icon} label={source.label} />
          <MetadataChip icon="edit-note" label={`${run.changedFileCount} files`} />
          <MetadataChip icon="fact-check" label={`${run.evidenceCount} evidence`} />
          <MetadataChip icon="schedule" label={relativeTime(run.startedAt)} />
        </View>
      </View>
      <MaterialIcons
        name={run.threadId ? 'chevron-right' : 'desktop-windows'}
        size={20}
        color={companionColors.subtle}
      />
    </TouchableOpacity>
  );
}

function WorkspaceSignalCard({
  signal,
  onPress,
}: {
  signal: MobileWorkspaceSignal;
  onPress: () => void;
}) {
  const tone = QUEUE_TONES[signal.priority];
  const source = signalSource(signal);

  return (
    <TouchableOpacity
      activeOpacity={0.78}
      onPress={onPress}
      style={workspaceSignalStyle}
    >
      <View style={[workspaceSignalIconStyle, { backgroundColor: source.background }]}>
        <MaterialIcons name={source.icon} size={18} color={source.color} />
      </View>
      <View style={{ flex: 1, gap: 5 }}>
        <View style={activityRunTopStyle}>
          <Text numberOfLines={1} style={[titleStyle, { flex: 1 }]}>
            {signal.title}
          </Text>
          <StatusPill label={signal.statusLabel} color={tone.color} background={tone.background} />
        </View>
        <Text numberOfLines={2} style={bodyStyle}>
          {signal.detail || source.label}
        </Text>
        <View style={activityMetaRowStyle}>
          <MetadataChip icon={source.icon} label={source.label} />
          {signal.repoName && <MetadataChip icon="folder" label={signal.repoName} />}
          <MetadataChip icon="schedule" label={relativeTime(signal.updatedAt)} />
        </View>
      </View>
      <MaterialIcons name="chevron-right" size={20} color={companionColors.subtle} />
    </TouchableOpacity>
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
          <MaterialIcons
            name="select-all"
            size={16}
            color={allSelected ? companionColors.onDark : companionColors.darkMuted}
          />
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
                color={selected ? companionColors.onDark : companionColors.darkMuted}
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

function ConsoleFact({ label, value }: { label: string; value: string }) {
  return (
    <View style={consoleFactStyle}>
      <Text style={consoleFactLabelStyle}>{label}</Text>
      <Text numberOfLines={1} style={consoleFactValueStyle}>
        {value}
      </Text>
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
      <View style={{ flex: 1, gap: 3 }}>
        <Text numberOfLines={1} style={[titleStyle, { color: tone.text }]}>
          {action.title}
        </Text>
        <Text numberOfLines={2} style={subtleStyle}>
          {action.subtitle}
        </Text>
      </View>
      <MaterialIcons name="chevron-right" size={20} color={tone.text} />
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
  onOpenThread,
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
  onOpenThread: (threadId: string) => void;
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
            label={busy ? 'Interrupt' : item.threadId ? 'Open thread' : 'Open Mac'}
            variant={busy ? 'danger' : 'secondary'}
            onPress={() =>
              busy
                ? onInterrupt(item.sessionId!)
                : item.threadId
                  ? onOpenThread(item.threadId)
                  : onOpenDesktop()
            }
            style={{ flexGrow: 1 }}
          />
        )}
        {item.kind === 'thread' && (
          <ActionButton
            label={item.threadId ? 'Open thread' : 'Open Mac'}
            variant="secondary"
            onPress={() => (item.threadId ? onOpenThread(item.threadId) : onOpenDesktop())}
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

function runSource(run: AgentRunSummary): {
  label: string;
  icon: IconName;
  color: CompanionColor;
  background: CompanionColor;
} {
  if (run.source === 'automation') {
    return {
      label: 'automation',
      icon: 'precision-manufacturing',
      color: companionColors.purple,
      background: companionColors.purpleSoft,
    };
  }
  if (run.source === 'code_review') {
    return {
      label: 'code review',
      icon: 'rate-review',
      color: companionColors.accentInk,
      background: companionColors.accentSoft,
    };
  }
  return {
    label: 'chat',
    icon: 'forum',
    color: companionColors.blue,
    background: companionColors.blueSoft,
  };
}

function signalSource(signal: MobileWorkspaceSignal): {
  label: string;
  icon: IconName;
  color: CompanionColor;
  background: CompanionColor;
} {
  if (signal.kind === 'security') {
    return {
      label: 'security',
      icon: 'shield',
      color: companionColors.red,
      background: companionColors.redSoft,
    };
  }
  if (signal.kind === 'code_review') {
    return {
      label: 'code review',
      icon: 'rate-review',
      color: companionColors.accentInk,
      background: companionColors.accentSoft,
    };
  }
  if (signal.kind === 'lifecycle') {
    return {
      label: 'lifecycle',
      icon: 'account-tree',
      color: companionColors.purple,
      background: companionColors.purpleSoft,
    };
  }
  return {
    label: 'work item',
    icon: 'assignment',
    color: companionColors.blue,
    background: companionColors.blueSoft,
  };
}

function runStatusLabel(status: AgentRunStatus): string {
  if (status === 'completed') return 'done';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  return status;
}

function healthTone(
  health: MobileWorkflowHealth,
): 'blue' | 'green' | 'amber' | 'red' | 'purple' | 'cyan' {
  if (health === 'needs-approval') return 'red';
  if (health === 'busy') return 'blue';
  if (health === 'ready') return 'green';
  if (health === 'idle') return 'cyan';
  return 'amber';
}

function homeHeadline(headline: string | undefined, item: MobileWorkQueueItem | undefined): string {
  if (item?.priority === 'critical' || item?.kind === 'approval') return item.title;
  return headline ?? 'Pair a Mac to start';
}

function homeDetail(
  detail: string | undefined,
  workspaceName: string | undefined,
  item: MobileWorkQueueItem | undefined,
): string | undefined {
  if (item) {
    const target = item.repoName ?? item.workspaceName ?? workspaceName;
    return target
      ? `${item.statusLabel} / ${target} / ${relativeTime(item.updatedAt)}`
      : item.detail;
  }
  return detail;
}

function titleFromMessage(message: string): string {
  const trimmed = message.replace(/\s+/g, ' ').trim();
  return trimmed.length > 44 ? `${trimmed.slice(0, 41)}...` : trimmed || 'Remote prompt';
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

function threadHref(threadId: string): RelativePathString {
  return `/(tabs)/chats/${encodeURIComponent(threadId)}` as RelativePathString;
}

function healthSignalHref(signalId: string): RelativePathString {
  return `/(tabs)/health/${encodeURIComponent(signalId)}` as RelativePathString;
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
    border: companionColors.blueBorder,
    text: companionColors.blue,
    iconBackground: companionColors.blueSoft,
  },
  green: {
    background: companionColors.greenSoft,
    border: companionColors.greenBorder,
    text: companionColors.green,
    iconBackground: companionColors.greenSoft,
  },
  amber: {
    background: companionColors.accentSoft,
    border: companionColors.accent,
    text: companionColors.accentInk,
    iconBackground: companionColors.accentSoft,
  },
  red: {
    background: companionColors.redSoft,
    border: companionColors.redBorder,
    text: companionColors.red,
    iconBackground: companionColors.redSoft,
  },
  purple: {
    background: companionColors.purpleSoft,
    border: companionColors.purpleBorder,
    text: companionColors.purple,
    iconBackground: companionColors.purpleSoft,
  },
};

const QUEUE_TONES: Record<
  MobileWorkQueueItem['priority'],
  { color: CompanionColor; background: CompanionColor }
> = {
  critical: { color: companionColors.red, background: companionColors.redSoft },
  high: { color: companionColors.accentInk, background: companionColors.accentSoft },
  normal: { color: companionColors.blue, background: companionColors.blueSoft },
  low: { color: companionColors.subtle, background: companionColors.surfaceMuted },
};

const RUN_STATUS_TONES: Record<AgentRunStatus, { color: CompanionColor; background: CompanionColor }> = {
  queued: { color: companionColors.subtle, background: companionColors.surfaceMuted },
  running: { color: companionColors.blue, background: companionColors.blueSoft },
  completed: { color: companionColors.green, background: companionColors.greenSoft },
  failed: { color: companionColors.red, background: companionColors.redSoft },
  cancelled: { color: companionColors.subtle, background: companionColors.surfaceMuted },
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
const nextActionStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 10,
  borderRadius: 10,
  borderWidth: 1,
  borderColor: companionColors.borderSubtle,
  backgroundColor: companionColors.surfaceMuted,
  padding: 10,
};
const nextActionIconStyle = {
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  width: 34,
  height: 34,
  borderRadius: 9,
  backgroundColor: companionColors.surface,
};
const nextActionTitleStyle = {
  color: companionColors.ink,
  fontSize: 14,
  fontWeight: '900' as const,
};
const nextActionDetailStyle = {
  color: companionColors.subtle,
  fontSize: 12,
  fontWeight: '800' as const,
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
  borderColor: companionColors.greenBorder,
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
  color: companionColors.onDark,
  fontSize: 16,
  fontWeight: '900' as const,
};
const heroStatusIconStyle = {
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  width: 36,
  height: 36,
  borderRadius: 10,
  backgroundColor: companionColors.darkIconSurface,
};
const consoleStripStyle = {
  flexDirection: 'row' as const,
  gap: 8,
  flexWrap: 'wrap' as const,
};
const consoleFactStyle = {
  flexGrow: 1,
  minWidth: 92,
  backgroundColor: companionColors.darkRaised,
  borderColor: companionColors.darkControlActive,
  borderWidth: 1,
  borderRadius: 8,
  paddingHorizontal: 10,
  paddingVertical: 9,
  gap: 2,
};
const consoleFactLabelStyle = {
  color: companionColors.darkMuted,
  fontSize: 11,
  fontWeight: '800' as const,
};
const consoleFactValueStyle = {
  color: companionColors.onDark,
  fontSize: 13,
  fontWeight: '900' as const,
};
const modeRowStyle = {
  flexDirection: 'row' as const,
  borderWidth: 1,
  borderColor: companionColors.darkBorder,
  borderRadius: 10,
  padding: 3,
  backgroundColor: companionColors.darkControl,
};
const modeButtonStyle = {
  flex: 1,
  alignItems: 'center' as const,
  borderRadius: 8,
  paddingVertical: 9,
};
const activeModeButtonStyle = { backgroundColor: companionColors.onDark };
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
  borderColor: companionColors.darkBorder,
  backgroundColor: companionColors.darkControl,
  paddingHorizontal: 12,
  paddingVertical: 8,
};
const selectedRepoChipStyle = {
  borderColor: companionColors.onDark,
  backgroundColor: companionColors.darkControlActive,
};
const repoChipTextStyle = {
  color: companionColors.darkMuted,
  fontSize: 13,
  fontWeight: '800' as const,
  maxWidth: 150,
};
const selectedRepoChipTextStyle = { color: companionColors.onDark };
const setupNoticeStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 10,
  borderRadius: 8,
  borderWidth: 1,
  borderColor: companionColors.darkBorder,
  backgroundColor: companionColors.darkRaised,
  padding: 12,
};
const setupNoticeTitleStyle = {
  color: companionColors.onDark,
  fontSize: 14,
  fontWeight: '900' as const,
};
const setupNoticeBodyStyle = {
  color: companionColors.darkMuted,
  fontSize: 12,
  lineHeight: 17,
  fontWeight: '700' as const,
};
const darkInputStyle = {
  ...inputStyle,
  minHeight: 96,
  backgroundColor: companionColors.darkControl,
  borderColor: companionColors.darkBorder,
  color: companionColors.onDark,
  textAlignVertical: 'top' as const,
};
const quickActionGridStyle = {
  gap: 10,
};
const quickActionStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  minHeight: 76,
  borderWidth: 1,
  borderRadius: 8,
  padding: 12,
  gap: 12,
};
const actionIconStyle = {
  width: 34,
  height: 34,
  borderRadius: 9,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
};
const activityRunStyle = {
  flexDirection: 'row' as const,
  alignItems: 'flex-start' as const,
  gap: 12,
  borderRadius: 8,
  borderWidth: 1,
  borderColor: companionColors.borderSubtle,
  backgroundColor: companionColors.surface,
  padding: 12,
};
const workspaceSignalStyle = {
  flexDirection: 'row' as const,
  alignItems: 'flex-start' as const,
  gap: 12,
  borderRadius: 8,
  borderWidth: 1,
  borderColor: companionColors.borderSubtle,
  backgroundColor: companionColors.surface,
  padding: 12,
};
const workspaceSignalIconStyle = {
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  width: 38,
  height: 38,
  borderRadius: 10,
};
const activityIconStyle = {
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  width: 38,
  height: 38,
  borderRadius: 10,
};
const activityRunTopStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 8,
};
const activityMetaRowStyle = {
  flexDirection: 'row' as const,
  flexWrap: 'wrap' as const,
  gap: 6,
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
const queueActionRowStyle = {
  flexDirection: 'row' as const,
  flexWrap: 'wrap' as const,
  gap: 8,
  marginTop: 2,
};

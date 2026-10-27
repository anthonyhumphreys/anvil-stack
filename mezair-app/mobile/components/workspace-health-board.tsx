import { MaterialIcons } from '@react-native-vector-icons/material-icons';
import { router, useLocalSearchParams, type RelativePathString } from 'expo-router';
import { useMemo, useState, type ComponentProps } from 'react';
import { RefreshControl, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import {
  ActionButton,
  EmptyState,
  Panel,
  ScreenHeader,
  SectionHeader,
  SignalGrid,
  SignalTile,
  StatusPill,
  bodyStyle,
  companionColors,
  screenStyle,
  scrollContentStyle,
  titleStyle,
  type CompanionColor,
} from '@/components/companion-ui';
import { useCompanion } from '@/contexts/companion-context';
import type {
  MobileStartChatInput,
  MobileWorkspaceSignal,
  MobileWorkspaceSignalKind,
} from '../../src/shared/types';

type IconName = ComponentProps<typeof MaterialIcons>['name'];
type WorkFilter = 'all' | MobileWorkspaceSignalKind;

const FILTERS: { id: WorkFilter; label: string; icon: IconName }[] = [
  { id: 'all', label: 'All', icon: 'view-list' },
  { id: 'code_review', label: 'Review', icon: 'rate-review' },
  { id: 'security', label: 'Security', icon: 'shield' },
  { id: 'lifecycle', label: 'Lifecycle', icon: 'account-tree' },
  { id: 'work_item', label: 'Items', icon: 'assignment' },
];

const QUICK_PLANS: {
  id: string;
  title: string;
  detail: string;
  actionId: string;
  icon: IconName;
}[] = [
  {
    id: 'review',
    title: 'Review plan',
    detail: 'Inspect open review findings and propose the next safe change.',
    actionId: 'review-diff',
    icon: 'rate-review',
  },
  {
    id: 'security',
    title: 'Security plan',
    detail: 'Triage current security findings before any risky approval.',
    actionId: 'security-sweep',
    icon: 'shield',
  },
  {
    id: 'work',
    title: 'Work plan',
    detail: 'Turn tracked items into the next useful mobile task.',
    actionId: 'work-items',
    icon: 'assignment',
  },
];

export function WorkspaceHealthBoard() {
  const { connection, overview, loading, refresh, startWorkflow, openOnDesktop } = useCompanion();
  const params = useLocalSearchParams<{ filter?: string }>();
  const [filter, setFilter] = useState<WorkFilter>(() => parseFilter(params.filter) ?? 'all');
  const [launchingActionId, setLaunchingActionId] = useState<string | null>(null);

  const activeWorkspace = overview?.activeWorkspace;
  const repos = useMemo(() => activeWorkspace?.repos ?? [], [activeWorkspace?.repos]);
  const health = overview?.workspaceHealth;
  const signals = health?.signals ?? [];
  const filteredSignals = signals.filter((signal) => filter === 'all' || signal.kind === filter);
  const canLaunch = Boolean(connection && activeWorkspace && repos.length > 0);
  const openSignalCount = signals.length;

  const startPlan = async (input: Omit<MobileStartChatInput, 'workspaceId' | 'repoIds'>) => {
    if (!canLaunch) return;
    setLaunchingActionId(input.actionId ?? 'custom');
    try {
      await startWorkflow({
        ...input,
        workspaceId: activeWorkspace?.id,
        repoIds: repos.map((repo) => repo.id),
        collaborationMode: 'plan',
      });
    } finally {
      setLaunchingActionId(null);
    }
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
        title="Work"
        detail={
          activeWorkspace
            ? `${openSignalCount} open signal${openSignalCount === 1 ? '' : 's'} from the desktop workspace.`
            : 'Choose a desktop workspace to load reviews, security, lifecycle, and work items.'
        }
        right={
          <StatusPill
            label={connection ? 'Live host' : 'Setup'}
            color={connection ? companionColors.green : companionColors.accentInk}
            background={connection ? companionColors.greenSoft : companionColors.accentSoft}
          />
        }
      />

      <SignalGrid>
        <SignalTile
          label="Review"
          value={health?.reviewFindingCount ?? 0}
          detail="findings"
          tone={(health?.reviewFindingCount ?? 0) > 0 ? 'amber' : 'green'}
          selected={filter === 'code_review'}
          onPress={() => setFilter(filter === 'code_review' ? 'all' : 'code_review')}
        />
        <SignalTile
          label="Security"
          value={health?.securityFindingCount ?? 0}
          detail={
            (health?.criticalCount ?? 0) > 0 ? `${health?.criticalCount} critical` : 'findings'
          }
          tone={(health?.securityFindingCount ?? 0) > 0 ? 'red' : 'green'}
          selected={filter === 'security'}
          onPress={() => setFilter(filter === 'security' ? 'all' : 'security')}
        />
        <SignalTile
          label="Work"
          value={(health?.lifecycleItemCount ?? 0) + (health?.workItemCount ?? 0)}
          detail="tracked"
          tone={
            (health?.lifecycleItemCount ?? 0) + (health?.workItemCount ?? 0) > 0
              ? 'purple'
              : 'neutral'
          }
          selected={filter === 'work_item' || filter === 'lifecycle'}
          onPress={() => setFilter(filter === 'work_item' ? 'all' : 'work_item')}
        />
      </SignalGrid>

      <Panel compact>
        <View style={filterRailStyle}>
          {FILTERS.map((item) => (
            <TouchableOpacity
              key={item.id}
              activeOpacity={0.78}
              onPress={() => setFilter(item.id)}
              style={[filterChipStyle, filter === item.id && filterChipActiveStyle]}
            >
              <MaterialIcons
                name={item.icon}
                size={15}
                color={filter === item.id ? companionColors.ink : companionColors.subtle}
              />
              <Text style={[filterChipTextStyle, filter === item.id && filterChipTextActiveStyle]}>
                {item.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </Panel>

      <View style={sectionStyle}>
        <SectionHeader
          title={filter === 'all' ? 'Open signals' : `${filterLabel(filter)} signals`}
          count={filteredSignals.length}
          detail="Evidence, files, remediation, and plan actions."
        />
        {filteredSignals.length > 0 ? (
          filteredSignals.map((signal) => <WorkSignalRow key={signal.id} signal={signal} />)
        ) : (
          <EmptyState
            title={activeWorkspace ? 'Clear' : 'No workspace'}
            body={
              activeWorkspace
                ? emptyFilterCopy(filter)
                : 'Pair a Mac and choose a workspace before browsing desktop work.'
            }
          />
        )}
      </View>

      <View style={sectionStyle}>
        <SectionHeader title="Start from here" />
        <View style={{ gap: 10 }}>
          {QUICK_PLANS.map((plan) => (
            <TouchableOpacity
              key={plan.id}
              activeOpacity={0.78}
              disabled={!canLaunch || Boolean(launchingActionId)}
              onPress={() => void startPlan({ actionId: plan.actionId })}
              style={[quickPlanStyle, (!canLaunch || Boolean(launchingActionId)) && disabledStyle]}
            >
              <View style={quickPlanIconStyle}>
                <MaterialIcons name={plan.icon} size={18} color={companionColors.accent} />
              </View>
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={titleStyle}>{plan.title}</Text>
                <Text style={bodyStyle}>{plan.detail}</Text>
              </View>
              <MaterialIcons name="arrow-forward" size={18} color={companionColors.subtle} />
            </TouchableOpacity>
          ))}
        </View>
        {!canLaunch ? (
          <Panel compact>
            <View style={setupRowStyle}>
              <MaterialIcons
                name={connection ? 'workspaces' : 'qr-code-scanner'}
                size={18}
                color={companionColors.accent}
              />
              <View style={{ flex: 1 }}>
                <Text style={titleStyle}>{connection ? 'Choose a workspace' : 'Pair a host'}</Text>
                <Text style={bodyStyle}>
                  {connection
                    ? 'Plans need an active desktop workspace with at least one repo.'
                    : 'Pairing connects this phone to desktop reviews, security, and work items.'}
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
          </Panel>
        ) : null}
      </View>
    </ScrollView>
  );
}

function WorkSignalRow({ signal }: { signal: MobileWorkspaceSignal }) {
  const source = signalSource(signal);
  const tone = signalTone(signal.priority);

  return (
    <TouchableOpacity
      activeOpacity={0.78}
      onPress={() => router.push(healthSignalHref(signal.id))}
      style={signalRowStyle}
    >
      <View style={[signalIconStyle, { backgroundColor: source.background }]}>
        <MaterialIcons name={source.icon} size={18} color={source.color} />
      </View>
      <View style={{ flex: 1, gap: 5 }}>
        <View style={signalTopRowStyle}>
          <Text numberOfLines={2} style={[titleStyle, { flex: 1 }]}>
            {signal.title}
          </Text>
          <StatusPill label={signal.statusLabel} color={tone.color} background={tone.background} />
        </View>
        {signal.detail ? (
          <Text numberOfLines={2} style={bodyStyle}>
            {signal.detail}
          </Text>
        ) : null}
        <View style={metaRowStyle}>
          <MetadataChip icon={source.icon} label={source.label} />
          {signal.repoName ? <MetadataChip icon="folder" label={signal.repoName} /> : null}
          <MetadataChip icon="schedule" label={relativeTime(signal.updatedAt)} />
        </View>
      </View>
      <MaterialIcons name="chevron-right" size={20} color={companionColors.subtle} />
    </TouchableOpacity>
  );
}

function MetadataChip({ icon, label }: { icon: IconName; label: string }) {
  return (
    <View style={metadataChipStyle}>
      <MaterialIcons name={icon} size={13} color={companionColors.subtle} />
      <Text numberOfLines={1} style={metadataChipTextStyle}>
        {label}
      </Text>
    </View>
  );
}

function signalSource(signal: MobileWorkspaceSignal): {
  label: string;
  icon: IconName;
  color: CompanionColor;
  background: CompanionColor;
} {
  if (signal.kind === 'security') {
    return {
      label: 'Security',
      icon: 'shield',
      color: companionColors.red,
      background: companionColors.redSoft,
    };
  }
  if (signal.kind === 'code_review') {
    return {
      label: 'Review',
      icon: 'rate-review',
      color: companionColors.accentInk,
      background: companionColors.accentSoft,
    };
  }
  if (signal.kind === 'lifecycle') {
    return {
      label: 'Lifecycle',
      icon: 'account-tree',
      color: companionColors.purple,
      background: companionColors.purpleSoft,
    };
  }
  return {
    label: 'Work item',
    icon: 'assignment',
    color: companionColors.blue,
    background: companionColors.blueSoft,
  };
}

function signalTone(priority: MobileWorkspaceSignal['priority']): {
  color: CompanionColor;
  background: CompanionColor;
} {
  if (priority === 'critical')
    return { color: companionColors.red, background: companionColors.redSoft };
  if (priority === 'high')
    return { color: companionColors.accentInk, background: companionColors.accentSoft };
  if (priority === 'normal')
    return { color: companionColors.blue, background: companionColors.blueSoft };
  return { color: companionColors.subtle, background: companionColors.surfaceMuted };
}

function filterLabel(filter: WorkFilter): string {
  if (filter === 'code_review') return 'Review';
  if (filter === 'security') return 'Security';
  if (filter === 'lifecycle') return 'Lifecycle';
  if (filter === 'work_item') return 'Work item';
  return 'Open';
}

function emptyFilterCopy(filter: WorkFilter): string {
  if (filter === 'code_review') return 'No open review findings from the active workspace.';
  if (filter === 'security') return 'No open security findings from the active workspace.';
  if (filter === 'lifecycle') return 'No lifecycle items need attention in this workspace.';
  if (filter === 'work_item') return 'No open cached work items need attention.';
  return 'No review findings, security findings, lifecycle items, or work items need attention.';
}

function parseFilter(value: string | string[] | undefined): WorkFilter | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (
    raw === 'all' ||
    raw === 'code_review' ||
    raw === 'security' ||
    raw === 'lifecycle' ||
    raw === 'work_item'
  ) {
    return raw;
  }
  return null;
}

function relativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'recently';
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))}m ago`;
  if (diff < 86_400_000) return `${Math.max(1, Math.floor(diff / 3_600_000))}h ago`;
  return `${Math.max(1, Math.floor(diff / 86_400_000))}d ago`;
}

function healthSignalHref(signalId: string): RelativePathString {
  return `/(tabs)/health/${encodeURIComponent(signalId)}` as RelativePathString;
}

const sectionStyle = { gap: 10 };
const filterRailStyle = {
  flexDirection: 'row' as const,
  flexWrap: 'wrap' as const,
  gap: 8,
};
const filterChipStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 6,
  borderRadius: 999,
  borderWidth: 1,
  borderColor: companionColors.borderSubtle,
  backgroundColor: companionColors.surfaceMuted,
  paddingHorizontal: 10,
  paddingVertical: 8,
};
const filterChipActiveStyle = {
  borderColor: companionColors.accent,
  backgroundColor: companionColors.accentSoft,
};
const filterChipTextStyle = {
  color: companionColors.subtle,
  fontSize: 12,
  fontWeight: '900' as const,
};
const filterChipTextActiveStyle = { color: companionColors.ink };
const signalRowStyle = {
  flexDirection: 'row' as const,
  alignItems: 'flex-start' as const,
  gap: 10,
  borderRadius: 14,
  borderWidth: 1,
  borderColor: companionColors.borderSubtle,
  backgroundColor: companionColors.surface,
  padding: 12,
};
const signalIconStyle = {
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  width: 38,
  height: 38,
  borderRadius: 10,
};
const signalTopRowStyle = {
  flexDirection: 'row' as const,
  alignItems: 'flex-start' as const,
  gap: 8,
};
const metaRowStyle = {
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
  paddingHorizontal: 8,
  paddingVertical: 4,
  maxWidth: 220,
};
const metadataChipTextStyle = {
  color: companionColors.subtle,
  fontSize: 11,
  fontWeight: '800' as const,
  maxWidth: 170,
};
const quickPlanStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 10,
  borderRadius: 14,
  borderWidth: 1,
  borderColor: companionColors.borderSubtle,
  backgroundColor: companionColors.surface,
  padding: 12,
};
const quickPlanIconStyle = {
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  width: 36,
  height: 36,
  borderRadius: 10,
  backgroundColor: companionColors.accentSoft,
};
const setupRowStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 10,
};
const disabledStyle = { opacity: 0.48 };

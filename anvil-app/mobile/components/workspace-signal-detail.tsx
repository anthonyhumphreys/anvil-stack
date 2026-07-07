import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { router, type RelativePathString } from 'expo-router';
import { useEffect, useMemo, useState, type ComponentProps } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import {
  ActionButton,
  BlockedNotice,
  EmptyState,
  Panel,
  SignalGrid,
  SignalTile,
  StatusPill,
  bodyStyle,
  companionColors,
  screenStyle,
  scrollContentStyle,
  subtleStyle,
  titleStyle,
  type CompanionColor,
} from '@/components/companion-ui';
import { useCompanion } from '@/contexts/companion-context';
import type { MobileWorkspaceSignal, MobileWorkspaceSignalDetail } from '../../src/shared/types';

type IconName = ComponentProps<typeof MaterialIcons>['name'];

export function WorkspaceSignalDetail({ signalId }: { signalId?: string }) {
  const {
    connection,
    overview,
    loading,
    refresh,
    fetchSignalDetail,
    startWorkflow,
    openOnDesktop,
  } = useCompanion();
  const [launching, setLaunching] = useState(false);
  const [detail, setDetail] = useState<MobileWorkspaceSignalDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const activeWorkspace = overview?.activeWorkspace;
  const repos = useMemo(() => activeWorkspace?.repos ?? [], [activeWorkspace?.repos]);
  const overviewSignal = overview?.workspaceHealth.signals.find(
    (candidate) => candidate.id === signalId,
  );
  const signal = detail?.signal ?? overviewSignal;
  const source = signal ? signalSource(signal) : null;
  const tone = signal ? signalTone(signal.priority) : null;
  const canLaunch = Boolean(connection && activeWorkspace && repos.length > 0 && signal?.actionId);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    if (!signalId || !connection) return;

    setDetailLoading(true);
    void fetchSignalDetail(signalId)
      .then((nextDetail) => {
        if (!cancelled) setDetail(nextDetail);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [connection, fetchSignalDetail, signalId]);

  const launchAction = async () => {
    if (!signal?.actionId || !activeWorkspace || repos.length === 0) return;
    const repoIds =
      signal.repoId && repos.some((repo) => repo.id === signal.repoId)
        ? [signal.repoId]
        : repos.map((repo) => repo.id);

    setLaunching(true);
    try {
      const result = await startWorkflow({
        actionId: signal.actionId,
        workspaceId: activeWorkspace.id,
        repoIds,
        collaborationMode: 'plan',
      });
      if (result?.thread.id) {
        router.replace(threadHref(result.thread.id));
      }
    } finally {
      setLaunching(false);
    }
  };

  return (
    <ScrollView
      style={screenStyle}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} />}
      contentContainerStyle={scrollContentStyle}
    >
      {!signal || !source || !tone ? (
        <EmptyState
          title="Signal unavailable"
          body="Refresh Home. The desktop host may have cleared or replaced this signal."
        />
      ) : (
        <>
          <Panel>
            <View style={headerRowStyle}>
              <View style={[signalIconStyle, { backgroundColor: source.background }]}>
                <MaterialIcons name={source.icon} size={22} color={source.color} />
              </View>
              <View style={{ flex: 1, gap: 5 }}>
                <Text selectable style={titleStyle}>
                  {signal.title}
                </Text>
                <Text style={subtleStyle}>
                  {source.label} / {relativeTime(signal.updatedAt)}
                </Text>
              </View>
              <StatusPill
                label={signal.statusLabel}
                color={tone.color}
                background={tone.background}
              />
            </View>

            {signal.detail ? (
              <Text selectable style={bodyStyle}>
                {signal.detail}
              </Text>
            ) : null}

            <View style={metadataRowStyle}>
              {signal.repoName && <MetadataChip icon="folder" label={signal.repoName} />}
              {signal.sourceId && <MetadataChip icon="tag" label={signal.sourceId} />}
              <MetadataChip icon="schedule" label={new Date(signal.updatedAt).toLocaleString()} />
            </View>
          </Panel>

          <SignalGrid>
            <SignalTile
              label="Priority"
              value={signal.priority}
              detail="signal"
              tone={signalToneName(signal)}
            />
            <SignalTile
              label="Source"
              value={source.shortLabel}
              detail="desktop"
              tone={source.tone}
            />
            <SignalTile label="Mode" value="Plan" detail="default" tone="blue" />
          </SignalGrid>

          {detailLoading && (
            <Panel compact>
              <Text style={titleStyle}>Loading Detail…</Text>
              <Text style={bodyStyle}>Fetching the desktop evidence for this signal.</Text>
            </Panel>
          )}

          {detail?.summary ? (
            <EvidencePanel title="Summary" body={detail.summary} icon="summarize" />
          ) : null}

          {detail?.description && detail.description !== signal.detail ? (
            <EvidencePanel title="Finding" body={detail.description} icon="subject" />
          ) : null}

          {detail?.recommendation ? (
            <EvidencePanel
              title={signal.kind === 'work_item' ? 'Acceptance criteria' : 'Recommendation'}
              body={detail.recommendation}
              icon={signal.kind === 'security' ? 'security' : 'tips-and-updates'}
              tone={signal.kind === 'security' ? 'danger' : 'default'}
            />
          ) : null}

          {detail?.files.length ? <FilesPanel files={detail.files} /> : null}

          {detail?.linkedWorkItemId ? (
            <Panel compact>
              <Text style={titleStyle}>Linked work item</Text>
              <View style={metadataRowStyle}>
                <MetadataChip icon="assignment" label={detail.linkedWorkItemId} />
              </View>
            </Panel>
          ) : null}

          {detail?.provenance.length ? <ProvenancePanel entries={detail.provenance} /> : null}

          {signal.kind === 'security' && (
            <BlockedNotice body="Security signals are inspection-first. Start a plan from here, then approve risky actions only after reviewing the desktop context." />
          )}

          <Panel tone="dark">
            <View style={actionHeaderStyle}>
              <MaterialIcons name="bolt" size={18} color={companionColors.accent} />
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={darkTitleStyle}>{actionTitle(signal)}</Text>
                <Text style={darkBodyStyle}>{actionDetail(signal, activeWorkspace?.name)}</Text>
              </View>
            </View>
            <ActionButton
              label={launching ? 'Starting…' : signal.actionId ? 'Start Plan' : 'Open Mac'}
              disabled={launching || (!canLaunch && Boolean(signal.actionId))}
              onPress={() => (signal.actionId ? void launchAction() : void openOnDesktop())}
              style={{
                backgroundColor: companionColors.accent,
                borderColor: companionColors.accent,
              }}
              textStyle={{ color: companionColors.dark }}
            />
            {!canLaunch && signal.actionId && (
              <Text style={darkBodyStyle}>
                Pair a host and choose a workspace with repos first.
              </Text>
            )}
          </Panel>

          {!detail && !detailLoading ? (
            <Panel compact>
              <Text style={titleStyle}>Desktop detail unavailable</Text>
              <Text style={bodyStyle}>
                The summary is still usable. Refresh if the Mac has just updated this signal.
              </Text>
            </Panel>
          ) : null}
        </>
      )}
    </ScrollView>
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

function EvidencePanel({
  title,
  body,
  icon,
  tone = 'default',
}: {
  title: string;
  body: string;
  icon: IconName;
  tone?: 'default' | 'danger';
}) {
  return (
    <Panel tone={tone}>
      <View style={panelHeaderStyle}>
        <MaterialIcons
          name={icon}
          size={18}
          color={tone === 'danger' ? companionColors.red : companionColors.blue}
        />
        <Text style={titleStyle}>{title}</Text>
      </View>
      <Text selectable style={bodyStyle}>
        {body}
      </Text>
    </Panel>
  );
}

function FilesPanel({ files }: { files: MobileWorkspaceSignalDetail['files'] }) {
  return (
    <Panel compact>
      <View style={panelHeaderStyle}>
        <MaterialIcons name="description" size={18} color={companionColors.blue} />
        <Text style={titleStyle}>Files</Text>
      </View>
      <View style={{ gap: 8 }}>
        {files.map((file) => (
          <View
            key={`${file.path}:${file.lineStart ?? ''}:${file.lineEnd ?? ''}`}
            style={fileRowStyle}
          >
            <MaterialIcons name="insert-drive-file" size={16} color={companionColors.subtle} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text selectable numberOfLines={2} style={filePathStyle}>
                {file.path}
              </Text>
              {typeof file.lineStart === 'number' ? (
                <Text style={subtleStyle}>
                  {file.lineEnd && file.lineEnd !== file.lineStart
                    ? `Lines ${file.lineStart}-${file.lineEnd}`
                    : `Line ${file.lineStart}`}
                </Text>
              ) : null}
            </View>
          </View>
        ))}
      </View>
    </Panel>
  );
}

function ProvenancePanel({ entries }: { entries: MobileWorkspaceSignalDetail['provenance'] }) {
  return (
    <Panel compact>
      <Text style={titleStyle}>Provenance</Text>
      <View style={{ gap: 8 }}>
        {entries.map((entry) => (
          <View key={`${entry.label}:${entry.value}`} style={provenanceRowStyle}>
            <Text style={provenanceLabelStyle}>{entry.label}</Text>
            <Text selectable style={provenanceValueStyle}>
              {entry.value}
            </Text>
          </View>
        ))}
      </View>
    </Panel>
  );
}

function signalSource(signal: MobileWorkspaceSignal): {
  label: string;
  shortLabel: string;
  tone: 'amber' | 'red' | 'purple' | 'blue';
  icon: IconName;
  color: CompanionColor;
  background: CompanionColor;
} {
  if (signal.kind === 'security') {
    return {
      label: 'Security finding',
      shortLabel: 'security',
      tone: 'red',
      icon: 'shield',
      color: companionColors.red,
      background: companionColors.redSoft,
    };
  }
  if (signal.kind === 'code_review') {
    return {
      label: 'Code review finding',
      shortLabel: 'review',
      tone: 'amber',
      icon: 'rate-review',
      color: companionColors.accentInk,
      background: companionColors.accentSoft,
    };
  }
  if (signal.kind === 'lifecycle') {
    return {
      label: 'Lifecycle item',
      shortLabel: 'lifecycle',
      tone: 'purple',
      icon: 'account-tree',
      color: companionColors.purple,
      background: companionColors.purpleSoft,
    };
  }
  return {
    label: 'Work item',
    shortLabel: 'work',
    tone: 'blue',
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

function signalToneName(
  signal: MobileWorkspaceSignal,
): 'neutral' | 'blue' | 'green' | 'amber' | 'red' | 'purple' | 'cyan' {
  if (signal.priority === 'critical') return 'red';
  if (signal.priority === 'high') return 'amber';
  if (signal.priority === 'normal') return 'blue';
  return 'neutral';
}

function actionTitle(signal: MobileWorkspaceSignal): string {
  if (signal.kind === 'security') return 'Investigate security risk';
  if (signal.kind === 'code_review') return 'Review the finding';
  if (signal.kind === 'lifecycle') return 'Plan lifecycle work';
  return 'Triage work item';
}

function actionDetail(signal: MobileWorkspaceSignal, workspaceName?: string): string {
  const target = signal.repoName ?? workspaceName ?? 'active workspace';
  if (signal.actionId) return `Starts a plan for ${target}.`;
  return `Open the desktop app for ${target}.`;
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

function threadHref(threadId: string): RelativePathString {
  return `/(tabs)/chats/${encodeURIComponent(threadId)}` as RelativePathString;
}

const headerRowStyle = {
  flexDirection: 'row' as const,
  alignItems: 'flex-start' as const,
  gap: 12,
};
const signalIconStyle = {
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  width: 44,
  height: 44,
  borderRadius: 10,
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
  maxWidth: 240,
};
const metadataTextStyle = {
  color: companionColors.subtle,
  fontSize: 12,
  fontWeight: '800' as const,
  maxWidth: 190,
};
const actionHeaderStyle = {
  flexDirection: 'row' as const,
  alignItems: 'flex-start' as const,
  gap: 10,
};
const panelHeaderStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 8,
};
const fileRowStyle = {
  flexDirection: 'row' as const,
  alignItems: 'flex-start' as const,
  gap: 8,
  borderRadius: 10,
  borderWidth: 1,
  borderColor: companionColors.borderSubtle,
  backgroundColor: companionColors.surfaceMuted,
  paddingHorizontal: 10,
  paddingVertical: 9,
};
const filePathStyle = {
  color: companionColors.ink,
  fontSize: 13,
  lineHeight: 18,
  fontWeight: '800' as const,
};
const provenanceRowStyle = {
  gap: 3,
  borderBottomWidth: 1,
  borderBottomColor: companionColors.borderSubtle,
  paddingBottom: 8,
};
const provenanceLabelStyle = {
  color: companionColors.subtle,
  fontSize: 11,
  fontWeight: '900' as const,
  textTransform: 'uppercase' as const,
};
const provenanceValueStyle = {
  color: companionColors.ink,
  fontSize: 13,
  lineHeight: 18,
  fontWeight: '700' as const,
};
const darkTitleStyle = {
  color: companionColors.onDark,
  fontSize: 16,
  fontWeight: '900' as const,
};
const darkBodyStyle = {
  color: companionColors.darkMuted,
  fontSize: 13,
  lineHeight: 19,
  fontWeight: '700' as const,
};

import { MaterialIcons } from '@react-native-vector-icons/material-icons';
import { router, type RelativePathString } from 'expo-router';
import { useMemo, useState } from 'react';
import { RefreshControl, ScrollView, Text, TextInput, Pressable, View } from 'react-native';
import {
  ActionButton,
  EmptyState,
  SectionHeader,
  companionColors,
  inputStyle,
  screenStyle,
  scrollContentStyle,
} from '@/components/companion-ui';
import { WorkspaceBar } from '@/components/workspace-bar';
import { useCompanion } from '@/contexts/companion-context';
import type { MobileWorkQueueItem } from '../../../src/shared/types';

export default function WorkScreen() {
  const { connection, overview, loading, refresh, interrupt } = useCompanion();
  const [workQuery, setWorkQuery] = useState('');
  const [showAllWorkItems, setShowAllWorkItems] = useState(false);
  const workspace = overview?.activeWorkspace;
  const sessions = (overview?.activeSessions ?? []).filter(
    (session) => !workspace || session.workspaceId === workspace.id,
  );
  const attention = (overview?.workQueue ?? []).filter(
    (item) =>
      item.kind !== 'thread' &&
      (!item.workspaceId || !workspace || item.workspaceId === workspace.id),
  );
  const recentThreads = (overview?.threads ?? [])
    .filter((thread) => !workspace || thread.workspaceId === workspace.id)
    .slice(0, 5);
  const currentIteration = overview?.currentIterationPath;
  const visibleWorkItems = useMemo(() => {
    const query = workQuery.trim().toLowerCase();
    return (overview?.workItems ?? [])
      .filter(
        (item) => showAllWorkItems || !currentIteration || item.iterationPath === currentIteration,
      )
      .filter(
        (item) =>
          !query ||
          `${item.id} ${item.title} ${item.state ?? ''} ${item.assignee ?? ''} ${item.iterationPath ?? ''}`
            .toLowerCase()
            .includes(query),
      );
  }, [currentIteration, overview?.workItems, showAllWorkItems, workQuery]);

  if (!connection) {
    return (
      <ScrollView
        style={screenStyle}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={scrollContentStyle}
      >
        <View style={{ paddingVertical: 44, gap: 18, alignItems: 'flex-start' }}>
          <View
            style={{
              width: 52,
              height: 52,
              borderRadius: 16,
              backgroundColor: companionColors.accentSoft,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <MaterialIcons name="link" size={26} color={companionColors.accentInk} />
          </View>
          <View style={{ gap: 6 }}>
            <Text
              accessibilityRole="header"
              style={{
                color: companionColors.ink,
                fontSize: 28,
                lineHeight: 34,
                fontWeight: '900',
              }}
            >
              Pair a Mac
            </Text>
            <Text style={{ color: companionColors.muted, fontSize: 16, lineHeight: 23 }}>
              Connect to Anvil on your main machine, then choose a workspace and keep work moving
              from here.
            </Text>
          </View>
          <ActionButton label="Open pairing" onPress={() => router.push('/(tabs)/settings')} />
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView
      style={screenStyle}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} />}
      contentContainerStyle={scrollContentStyle}
    >
      <WorkspaceBar />

      <View style={{ gap: 8 }}>
        <SectionHeader
          title={showAllWorkItems ? 'Work items' : currentIteration || 'Work items'}
          count={visibleWorkItems.length}
        />
        <TextInput
          accessibilityLabel="Search work items"
          value={workQuery}
          onChangeText={setWorkQuery}
          placeholder="Search ID, title, state, or assignee"
          placeholderTextColor={companionColors.faint}
          returnKeyType="search"
          style={[inputStyle, { minHeight: 46 }]}
        />
        {currentIteration && (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <ScopeButton
              title="Current sprint"
              selected={!showAllWorkItems}
              onPress={() => setShowAllWorkItems(false)}
            />
            <ScopeButton
              title="All open"
              selected={showAllWorkItems}
              onPress={() => setShowAllWorkItems(true)}
            />
          </View>
        )}
        {visibleWorkItems.length === 0 ? (
          <EmptyState
            title={workQuery ? 'No matching work' : 'No open work items'}
            body={
              workQuery
                ? 'Try a broader search or switch to all open work.'
                : 'Synced work appears here.'
            }
          />
        ) : (
          visibleWorkItems.slice(0, 8).map((item) => (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              onPress={() =>
                router.push(
                  `/(tabs)/health/work-item:${encodeURIComponent(item.id)}` as RelativePathString,
                )
              }
              style={rowStyle}
            >
              <View style={{ minWidth: 54 }}>
                <Text
                  numberOfLines={1}
                  style={{ color: companionColors.accentInk, fontSize: 12, fontWeight: '900' }}
                >
                  {item.id}
                </Text>
                <Text numberOfLines={1} style={{ color: companionColors.subtle, fontSize: 11 }}>
                  {item.state ?? 'Open'}
                </Text>
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={2} style={rowTitleStyle}>
                  {item.title}
                </Text>
                <Text numberOfLines={1} style={rowDetailStyle}>
                  {[item.type, item.assignee].filter(Boolean).join(' · ') ||
                    item.iterationPath ||
                    'Tracked work'}
                </Text>
              </View>
              <MaterialIcons name="chevron-right" size={22} color={companionColors.faint} />
            </Pressable>
          ))
        )}
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New task"
        accessibilityHint="Start work in the selected workspace"
        onPress={() => router.push('/new-task' as RelativePathString)}
        style={({ pressed }) => ({
          minHeight: 58,
          borderRadius: 16,
          borderCurve: 'continuous',
          paddingHorizontal: 16,
          backgroundColor: pressed ? companionColors.accentInk : companionColors.accent,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
        })}
      >
        <MaterialIcons name="add" size={24} color="#33200a" />
        <View style={{ flex: 1 }}>
          <Text style={{ color: '#33200a', fontSize: 17, fontWeight: '900' }}>New task</Text>
          <Text numberOfLines={1} style={{ color: '#5b3a0c', fontSize: 13 }}>
            {workspace ? `Start in ${workspace.name}` : 'Choose a workspace first'}
          </Text>
        </View>
        <MaterialIcons name="arrow-forward" size={21} color="#33200a" />
      </Pressable>

      <View style={{ gap: 8 }}>
        <SectionHeader title="Needs you" count={attention.length} />
        {attention.length === 0 ? (
          <EmptyState title="Nothing blocked" body="Approvals and failed work will appear here." />
        ) : (
          attention
            .slice(0, 4)
            .map((item) => <WorkRow key={item.id} item={item} onInterrupt={interrupt} />)
        )}
      </View>

      <View style={{ gap: 8 }}>
        <SectionHeader title="Active work" count={sessions.length} />
        {sessions.length === 0 ? (
          <EmptyState title="No active sessions" body="Start a task or resume a recent thread." />
        ) : (
          sessions.map((session) => (
            <Pressable
              key={session.id}
              accessibilityRole="button"
              onPress={() => session.appThreadId && router.push(threadHref(session.appThreadId))}
              style={rowStyle}
            >
              <StatusDot active={session.status === 'busy' || session.status === 'starting'} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={1} style={rowTitleStyle}>
                  {session.personaId}
                </Text>
                <Text numberOfLines={1} style={rowDetailStyle}>
                  {session.status}
                </Text>
              </View>
              {(session.status === 'busy' || session.status === 'starting') && (
                <ActionButton
                  label="Stop"
                  variant="secondary"
                  onPress={() => void interrupt(session.id)}
                  style={{ minHeight: 44, paddingVertical: 8 }}
                />
              )}
            </Pressable>
          ))
        )}
      </View>

      <View style={{ gap: 8 }}>
        <SectionHeader title="Recent" count={recentThreads.length} />
        {recentThreads.map((thread) => (
          <Pressable
            key={thread.id}
            accessibilityRole="button"
            onPress={() => router.push(threadHref(thread.id))}
            style={rowStyle}
          >
            <MaterialIcons name="chat-bubble-outline" size={20} color={companionColors.subtle} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={rowTitleStyle}>
                {thread.title}
              </Text>
              <Text numberOfLines={1} style={rowDetailStyle}>
                {thread.preview || `${thread.messageCount} messages`}
              </Text>
            </View>
            <MaterialIcons name="chevron-right" size={22} color={companionColors.faint} />
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

function ScopeButton({
  title,
  selected,
  onPress,
}: {
  title: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={{
        minHeight: 44,
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 11,
        borderCurve: 'continuous',
        backgroundColor: selected ? companionColors.accentSoft : companionColors.surfaceMuted,
      }}
    >
      <Text
        style={{
          color: selected ? companionColors.accentInk : companionColors.subtle,
          fontSize: 13,
          fontWeight: '800',
        }}
      >
        {title}
      </Text>
    </Pressable>
  );
}

function WorkRow({
  item,
  onInterrupt,
}: {
  item: MobileWorkQueueItem;
  onInterrupt: (id: string) => Promise<void>;
}) {
  const href = item.threadId ? threadHref(item.threadId) : '/(tabs)/approvals';
  return (
    <Pressable accessibilityRole="button" onPress={() => router.push(href)} style={rowStyle}>
      <MaterialIcons
        name={item.kind === 'approval' ? 'priority-high' : 'error-outline'}
        size={21}
        color={companionColors.red}
      />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={rowTitleStyle}>
          {item.title}
        </Text>
        <Text numberOfLines={2} style={rowDetailStyle}>
          {item.detail}
        </Text>
      </View>
      {item.sessionId && item.kind === 'session' ? (
        <ActionButton
          label="Stop"
          variant="secondary"
          onPress={() => void onInterrupt(item.sessionId!)}
          style={{ minHeight: 44, paddingVertical: 8 }}
        />
      ) : (
        <MaterialIcons name="chevron-right" size={22} color={companionColors.faint} />
      )}
    </Pressable>
  );
}

function StatusDot({ active }: { active: boolean }) {
  return (
    <View
      style={{
        width: 9,
        height: 9,
        borderRadius: 5,
        backgroundColor: active ? companionColors.green : companionColors.faint,
      }}
    />
  );
}

const rowStyle = {
  minHeight: 62,
  paddingHorizontal: 14,
  paddingVertical: 10,
  borderRadius: 14,
  borderCurve: 'continuous' as const,
  backgroundColor: companionColors.surface,
  borderWidth: 1,
  borderColor: companionColors.borderSubtle,
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 11,
};
const rowTitleStyle = { color: companionColors.ink, fontSize: 15, fontWeight: '800' as const };
const rowDetailStyle = { color: companionColors.subtle, fontSize: 13, lineHeight: 18 };

function threadHref(threadId: string): RelativePathString {
  return `/(tabs)/chats/${encodeURIComponent(threadId)}` as RelativePathString;
}

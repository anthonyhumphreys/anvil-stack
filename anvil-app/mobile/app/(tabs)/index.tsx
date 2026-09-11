import { MaterialIcons } from '@react-native-vector-icons/material-icons';
import { router, type RelativePathString } from 'expo-router';
import type { ComponentProps, ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  ActionButton,
  companionColors as colors,
  screenStyle,
  scrollContentStyle,
} from '@/components/companion-ui';
import { WorkspaceBar } from '@/components/workspace-bar';
import { useCompanion } from '@/contexts/companion-context';
import { homeSummary } from '@/lib/home-summary';
import { useOpenThread } from '@/lib/routes';

type IconName = ComponentProps<typeof MaterialIcons>['name'];

export default function HomeScreen() {
  const { connection, overview, loading, refresh, error, usingCachedOverview, openOnDesktop } =
    useCompanion();
  const openThread = useOpenThread();
  const { attention, running, recent } = overview
    ? homeSummary(overview)
    : { attention: [], running: [], recent: [] };
  const workspace = overview?.activeWorkspace;
  const stale = Boolean(error || usingCachedOverview);

  return (
    <ScrollView
      style={screenStyle}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={
        connection ? <RefreshControl refreshing={loading} onRefresh={refresh} /> : undefined
      }
      contentContainerStyle={[scrollContentStyle, styles.content]}
    >
      <View style={styles.heading}>
        <Text accessibilityRole="header" style={styles.title}>
          Home
        </Text>
        {connection && overview && (
          <ActionButton
            label="New task"
            onPress={() => router.push('/new-task' as RelativePathString)}
            disabled={!workspace || stale}
            style={styles.newTask}
            textStyle={styles.newTaskText}
          />
        )}
      </View>

      {!connection ? (
        <View style={styles.welcome}>
          <MaterialIcons name="devices" size={36} color={colors.subtle} />
          <Text accessibilityRole="header" style={styles.welcomeTitle}>
            Take your workspace with you
          </Text>
          <Text style={styles.body}>
            Check on agents, review approvals, and pick up a thread from your phone.
          </Text>
          <ActionButton label="Pair your Mac" onPress={() => router.push('/(tabs)/settings')} />
          <Text style={styles.detail}>Open mobile pairing in Anvil on your Mac to connect.</Text>
        </View>
      ) : (
        <>
          <WorkspaceBar />
          {stale && (
            <View accessibilityRole="alert" style={styles.notice}>
              <Text style={styles.rowTitle}>
                {overview ? 'Showing last saved activity' : 'Unable to load your workspace'}
              </Text>
              <Text style={styles.body}>
                {error || 'Reconnect to your Mac to get the latest activity.'}
              </Text>
              <ActionButton
                label="Retry connection"
                variant="secondary"
                onPress={() => void refresh()}
              />
              <Pressable
                accessibilityRole="button"
                onPress={() => router.navigate('/(tabs)/settings')}
                style={styles.sectionAction}
              >
                <Text style={styles.actionText}>Connection settings</Text>
              </Pressable>
            </View>
          )}
          {!overview ? (
            !stale ? (
              <View style={styles.welcome}>
                <ActivityIndicator color={colors.subtle} />
                <Text style={styles.body}>Loading your workspace…</Text>
              </View>
            ) : null
          ) : (
            <>
              {attention.length > 0 && (
                <Section
                  title="Needs attention"
                  action="Open inbox"
                  onAction={() => router.navigate('/(tabs)/approvals')}
                >
                  {attention.map((item) => (
                    <HomeRow
                      key={item.id}
                      icon={item.kind === 'approval' ? 'pending-actions' : 'error-outline'}
                      tone="attention"
                      title={item.title}
                      detail={`${item.statusLabel} · ${item.detail}`}
                      onPress={() =>
                        item.kind === 'approval'
                          ? router.navigate('/(tabs)/approvals')
                          : item.threadId
                            ? openThread(item.threadId)
                            : void openOnDesktop()
                      }
                    />
                  ))}
                </Section>
              )}
              {running.length > 0 && (
                <Section title="Running">
                  {running.map((session) => {
                    const thread = overview.threads.find(
                      (candidate) =>
                        candidate.id === session.appThreadId ||
                        candidate.activeSessionId === session.id,
                    );
                    const threadId = thread?.id ?? session.appThreadId;
                    return (
                      <HomeRow
                        key={session.id}
                        icon="bolt"
                        tone="running"
                        title={thread?.title ?? `${session.personaId} session`}
                        detail={`${session.status === 'starting' ? 'Starting' : 'Working'} · ${session.personaId}${!threadId ? ' · Open on Mac' : ''}`}
                        onPress={() => (threadId ? openThread(threadId) : void openOnDesktop())}
                      />
                    );
                  })}
                </Section>
              )}
              {attention.length === 0 && running.length === 0 && (
                <View style={styles.quiet}>
                  <Text style={styles.rowTitle}>
                    {stale ? 'No activity in this snapshot' : 'No work needs your attention'}
                  </Text>
                  <Text style={styles.body}>
                    {stale
                      ? 'Reconnect to your Mac to resume work.'
                      : workspace
                        ? 'Start a task or continue a conversation below.'
                        : 'Choose a workspace above to start a task.'}
                  </Text>
                </View>
              )}
              {recent.length > 0 && (
                <Section
                  title="Recent threads"
                  action="All threads"
                  onAction={() => router.navigate('/(tabs)/chats')}
                >
                  {recent.map((thread) => (
                    <HomeRow
                      key={thread.id}
                      icon="chat-bubble-outline"
                      title={thread.title}
                      detail={thread.preview || `${thread.messageCount} messages`}
                      onPress={() => openThread(thread.id)}
                    />
                  ))}
                </Section>
              )}
              <Section title="Workspace">
                <HomeRow
                  icon="assignment"
                  title="Work items"
                  detail={
                    overview.currentIterationPath
                      ? `Current sprint · ${overview.workItems.length} open items in total`
                      : `${overview.workItems.length} open items`
                  }
                  onPress={() => router.push('/work-items' as RelativePathString)}
                />
                <HomeRow
                  icon="fact-check"
                  title="Reviews & security"
                  detail="Browse findings and workspace health"
                  onPress={() => router.push('/(tabs)/work')}
                />
              </Section>
            </>
          )}
        </>
      )}
    </ScrollView>
  );
}

function Section({
  title,
  action,
  onAction,
  children,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeading}>
        <Text accessibilityRole="header" style={styles.sectionTitle}>
          {title}
        </Text>
        {action && (
          <Pressable
            accessibilityRole="button"
            onPress={onAction}
            style={({ pressed }) => [styles.sectionAction, pressed && styles.pressed]}
          >
            <Text style={styles.actionText}>{action}</Text>
          </Pressable>
        )}
      </View>
      <View style={styles.list}>{children}</View>
    </View>
  );
}

function HomeRow({
  icon,
  title,
  detail,
  onPress,
  tone,
}: {
  icon: IconName;
  title: string;
  detail: string;
  onPress: () => void;
  tone?: 'attention' | 'running';
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <MaterialIcons
        name={icon}
        size={22}
        color={
          tone === 'attention' ? colors.red : tone === 'running' ? colors.green : colors.subtle
        }
      />
      <View style={styles.rowContent}>
        <Text numberOfLines={2} style={styles.rowTitle}>
          {title}
        </Text>
        <Text numberOfLines={2} style={styles.detail}>
          {detail}
        </Text>
      </View>
      <MaterialIcons name="chevron-right" size={22} color={colors.subtle} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { gap: 24, width: '100%', maxWidth: 760, alignSelf: 'center' },
  heading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 12,
  },
  title: { color: colors.ink, fontSize: 32, fontWeight: '700' },
  newTask: {
    minHeight: 48,
    backgroundColor: colors.accent,
    borderColor: colors.accent,
    borderRadius: 12,
  },
  newTaskText: { color: '#33200a', fontWeight: '700' },
  welcome: { paddingVertical: 32, gap: 20, alignItems: 'flex-start' },
  welcomeTitle: { color: colors.ink, fontSize: 26, fontWeight: '700' },
  body: { color: colors.muted, fontSize: 16, lineHeight: 24 },
  detail: { color: colors.subtle, fontSize: 14, lineHeight: 20 },
  notice: { padding: 16, gap: 12, backgroundColor: colors.surface, borderRadius: 12 },
  quiet: { gap: 6, paddingVertical: 8 },
  section: { gap: 8 },
  sectionHeading: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  sectionTitle: { flex: 1, color: colors.ink, fontSize: 18, fontWeight: '600' },
  sectionAction: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 8, borderRadius: 8 },
  actionText: { color: colors.accentInk, fontSize: 14, fontWeight: '600' },
  list: { backgroundColor: colors.surface, borderRadius: 12, overflow: 'hidden' },
  row: {
    minHeight: 80,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  pressed: { backgroundColor: colors.surfaceMuted },
  rowContent: { flex: 1, minWidth: 0, gap: 4 },
  rowTitle: { color: colors.ink, fontSize: 16, fontWeight: '600' },
});

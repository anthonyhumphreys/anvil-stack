import { MaterialIcons } from '@react-native-vector-icons/material-icons';
import { useMemo, useState } from 'react';
import { RefreshControl, ScrollView, Text, TextInput, Pressable, View } from 'react-native';
import {
  EmptyState,
  companionColors,
  inputStyle,
  screenStyle,
  scrollContentStyle,
} from '@/components/companion-ui';
import { WorkspaceBar } from '@/components/workspace-bar';
import { useCompanion } from '@/contexts/companion-context';
import { useOpenThread } from '@/lib/routes';

export default function ThreadsScreen() {
  const { overview, threads, loading, refresh } = useCompanion();
  const openThread = useOpenThread();
  const [query, setQuery] = useState('');
  const [allWorkspaces, setAllWorkspaces] = useState(false);
  const workspace = overview?.activeWorkspace;
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return [...threads]
      .filter((thread) => allWorkspaces || !workspace || thread.workspaceId === workspace.id)
      .filter(
        (thread) =>
          !normalized ||
          `${thread.title} ${thread.preview ?? ''} ${thread.personaId}`
            .toLowerCase()
            .includes(normalized),
      )
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }, [allWorkspaces, query, threads, workspace]);

  return (
    <ScrollView
      style={screenStyle}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} />}
      contentContainerStyle={scrollContentStyle}
    >
      <WorkspaceBar />
      <TextInput
        accessibilityLabel="Search threads"
        value={query}
        onChangeText={setQuery}
        placeholder="Search threads"
        placeholderTextColor={companionColors.faint}
        returnKeyType="search"
        style={[inputStyle, { minHeight: 48 }]}
      />
      <View
        accessibilityRole="radiogroup"
        style={{
          flexDirection: 'row',
          padding: 3,
          borderRadius: 12,
          backgroundColor: companionColors.surfaceMuted,
        }}
      >
        <ScopeButton
          title="Workspace"
          selected={!allWorkspaces}
          onPress={() => setAllWorkspaces(false)}
        />
        <ScopeButton
          title="All workspaces"
          selected={allWorkspaces}
          onPress={() => setAllWorkspaces(true)}
        />
      </View>
      {visible.length === 0 ? (
        <EmptyState
          title="No threads found"
          body={query ? 'Try a different search.' : 'Start a task from Work.'}
        />
      ) : (
        <View style={{ gap: 8 }}>
          {visible.map((thread) => (
            <Pressable
              key={thread.id}
              accessibilityRole="button"
              accessibilityLabel={`${thread.title}${thread.pendingApprovalCount ? `, ${thread.pendingApprovalCount} approvals waiting` : ''}`}
              onPress={() => openThread(thread.id)}
              style={({ pressed }) => ({
                minHeight: 70,
                padding: 14,
                borderRadius: 14,
                borderCurve: 'continuous',
                backgroundColor: pressed ? companionColors.surfaceMuted : companionColors.surface,
                borderWidth: 1,
                borderColor: companionColors.borderSubtle,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 11,
              })}
            >
              <View
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 11,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: thread.activeSessionId
                    ? companionColors.greenSoft
                    : companionColors.surfaceMuted,
                }}
              >
                <MaterialIcons
                  name={thread.activeSessionId ? 'bolt' : 'chat-bubble-outline'}
                  size={18}
                  color={thread.activeSessionId ? companionColors.green : companionColors.subtle}
                />
              </View>
              <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                  <Text
                    numberOfLines={1}
                    style={{
                      flex: 1,
                      color: companionColors.ink,
                      fontSize: 15,
                      fontWeight: '800',
                    }}
                  >
                    {thread.title}
                  </Text>
                  {thread.pendingApprovalCount > 0 && (
                    <Text style={{ color: companionColors.red, fontSize: 12, fontWeight: '800' }}>
                      {thread.pendingApprovalCount}
                    </Text>
                  )}
                </View>
                <Text
                  numberOfLines={2}
                  style={{ color: companionColors.subtle, fontSize: 13, lineHeight: 18 }}
                >
                  {thread.preview || `${thread.messageCount} messages`}
                </Text>
              </View>
              <MaterialIcons name="chevron-right" size={22} color={companionColors.faint} />
            </Pressable>
          ))}
        </View>
      )}
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
        borderRadius: 9,
        backgroundColor: selected ? companionColors.surface : 'transparent',
      }}
    >
      <Text
        style={{
          color: selected ? companionColors.ink : companionColors.subtle,
          fontSize: 13,
          fontWeight: '800',
        }}
      >
        {title}
      </Text>
    </Pressable>
  );
}

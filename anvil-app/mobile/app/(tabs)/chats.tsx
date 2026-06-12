import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useState } from 'react';
import { RefreshControl, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import {
  ActionButton,
  EmptyState,
  Panel,
  ScreenHeader,
  SectionHeader,
  bodyStyle,
  companionColors,
  inputStyle,
  screenStyle,
  scrollContentStyle,
  titleStyle,
} from '@/components/companion-ui';
import { useCompanion } from '@/contexts/companion-context';

export default function ChatsScreen() {
  const {
    threads,
    selectedThreadId,
    selectedThreadHistory,
    loading,
    refresh,
    selectThread,
    startWorkflow,
    sendMessage,
    interrupt,
  } = useCompanion();
  const selectedThread = threads.find((thread) => thread.id === selectedThreadId) ?? threads[0];
  const [launchDraft, setLaunchDraft] = useState('');
  const [draft, setDraft] = useState('');

  const openThread = async (threadId: string) => {
    await selectThread(threadId);
  };

  const submit = async () => {
    if (!selectedThread || !draft.trim()) return;
    const message = draft.trim();
    setDraft('');
    if (selectedThread.activeSessionId) {
      await sendMessage(selectedThread.id, selectedThread.activeSessionId, message);
      return;
    }
    await startWorkflow({ message, title: 'Remote prompt', personaId: selectedThread.personaId });
  };

  const launchFromPhone = async () => {
    if (!launchDraft.trim()) return;
    const message = launchDraft.trim();
    setLaunchDraft('');
    await startWorkflow({ message, title: 'Remote prompt' });
  };

  return (
    <ScrollView
      style={screenStyle}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} />}
      contentContainerStyle={scrollContentStyle}
    >
      <ScreenHeader
        eyebrow="Remote threads"
        title="Chats"
        detail="Start a fresh prompt or steer the desktop session already doing the work."
      />

      <Panel tone="dark" style={launchPanelStyle}>
        <View style={launchHeaderStyle}>
          <View style={launchIconStyle}>
            <MaterialIcons name="bolt" size={18} color={companionColors.accent} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={darkTitleStyle}>Start from your phone</Text>
            <Text style={darkBodyStyle}>
              Send a prompt into the active workspace. The Mac keeps the repo context and the
              dangerous toys.
            </Text>
          </View>
        </View>
        <TextInput
          value={launchDraft}
          onChangeText={setLaunchDraft}
          placeholder="Review the current change and find the riskiest missing test..."
          placeholderTextColor="#98a2b3"
          multiline
          style={darkInputStyle}
        />
        <ActionButton
          label="Launch Codex"
          onPress={() => void launchFromPhone()}
          disabled={!launchDraft.trim()}
          style={{ backgroundColor: companionColors.accent, borderColor: companionColors.accent }}
          textStyle={{ color: companionColors.dark }}
        />
      </Panel>

      <View style={sectionStyle}>
        <SectionHeader title="Threads" count={threads.length} />
        {threads.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={threadRailStyle}
          >
            {threads.map((thread) => {
              const selected = selectedThread?.id === thread.id;
              return (
                <TouchableOpacity
                  key={thread.id}
                  onPress={() => void openThread(thread.id)}
                  style={[threadPillStyle, selected && selectedThreadPillStyle]}
                >
                  <Text
                    numberOfLines={1}
                    style={[threadPillTextStyle, selected && selectedThreadPillTextStyle]}
                  >
                    {thread.title}
                  </Text>
                  {thread.pendingApprovalCount > 0 && (
                    <View style={threadBadgeStyle}>
                      <Text style={threadBadgeTextStyle}>{thread.pendingApprovalCount}</Text>
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        ) : (
          <EmptyState title="No threads yet" body="Start a desktop chat first, then it appears here." />
        )}
      </View>

      {!selectedThread ? null : (
        <Panel>
          <View style={selectedHeaderStyle}>
            <View style={{ flex: 1, gap: 4 }}>
              <Text selectable style={titleStyle}>
                {selectedThread.title}
              </Text>
              <Text style={bodyStyle}>
                {selectedThread.activeSessionStatus
                  ? `Session ${selectedThread.activeSessionStatus}`
                  : 'No active session'}
              </Text>
            </View>
            {selectedThread.activeSessionId && (
              <ActionButton
                label="Interrupt"
                variant="danger"
                onPress={() => void interrupt(selectedThread.activeSessionId!)}
                style={{ paddingVertical: 8 }}
              />
            )}
          </View>

          <View style={messageListStyle}>
            {selectedThreadHistory.length === 0 ? (
              <EmptyState
                title="No saved messages loaded"
                body={selectedThread.preview || 'Open or refresh the thread to load its recent history.'}
              />
            ) : (
              selectedThreadHistory.slice(-12).map((message) => {
                const user = message.role === 'user';
                return (
                  <View key={message.id} style={[messageBubbleStyle, user && userBubbleStyle]}>
                    <Text style={[messageRoleStyle, user && userRoleStyle]}>{message.role}</Text>
                    <Text selectable style={messageTextStyle}>
                      {message.content}
                    </Text>
                  </View>
                );
              })
            )}
          </View>

          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={
              selectedThread.activeSessionId
                ? 'Send input to Codex...'
                : 'No active session. This will launch a new one.'
            }
            placeholderTextColor={companionColors.faint}
            multiline
            style={[inputStyle, composerInputStyle]}
          />
          <ActionButton
            label={selectedThread.activeSessionId ? 'Send' : 'Launch'}
            onPress={() => void submit()}
            disabled={!draft.trim()}
          />
        </Panel>
      )}
    </ScrollView>
  );
}

const launchPanelStyle = { gap: 14 };
const launchHeaderStyle = {
  flexDirection: 'row' as const,
  gap: 12,
  alignItems: 'flex-start' as const,
};
const launchIconStyle = {
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  width: 38,
  height: 38,
  borderRadius: 10,
  backgroundColor: '#1f2937',
};
const darkTitleStyle = { color: '#fcfcfd', fontSize: 20, fontWeight: '900' as const };
const darkBodyStyle = { color: companionColors.darkMuted, fontSize: 14, lineHeight: 20 };
const darkInputStyle = {
  ...inputStyle,
  minHeight: 94,
  backgroundColor: '#1d2939',
  borderColor: '#475467',
  color: '#fcfcfd',
  textAlignVertical: 'top' as const,
};
const sectionStyle = { gap: 10 };
const threadRailStyle = { gap: 8, paddingRight: 4 };
const threadPillStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 8,
  minHeight: 42,
  maxWidth: 220,
  backgroundColor: companionColors.surface,
  borderColor: companionColors.borderSubtle,
  borderWidth: 1,
  borderRadius: 999,
  paddingHorizontal: 14,
  paddingVertical: 10,
};
const selectedThreadPillStyle = {
  backgroundColor: companionColors.dark,
  borderColor: companionColors.dark,
};
const threadPillTextStyle = {
  color: companionColors.ink,
  fontWeight: '800' as const,
  maxWidth: 170,
};
const selectedThreadPillTextStyle = { color: '#fcfcfd' };
const threadBadgeStyle = {
  minWidth: 22,
  alignItems: 'center' as const,
  borderRadius: 999,
  paddingHorizontal: 6,
  paddingVertical: 2,
  backgroundColor: companionColors.accent,
};
const threadBadgeTextStyle = {
  color: companionColors.dark,
  fontSize: 12,
  fontWeight: '900' as const,
};
const selectedHeaderStyle = {
  flexDirection: 'row' as const,
  justifyContent: 'space-between' as const,
  gap: 12,
};
const messageListStyle = { gap: 10 };
const messageBubbleStyle = {
  backgroundColor: companionColors.surfaceMuted,
  borderColor: companionColors.borderSubtle,
  borderWidth: 1,
  borderRadius: 10,
  padding: 12,
};
const userBubbleStyle = {
  backgroundColor: companionColors.blueSoft,
  borderColor: '#b2ddff',
};
const messageRoleStyle = {
  color: companionColors.subtle,
  fontWeight: '800' as const,
  marginBottom: 4,
};
const userRoleStyle = { color: companionColors.blue };
const messageTextStyle = { color: companionColors.ink, lineHeight: 20 };
const composerInputStyle = { minHeight: 92, textAlignVertical: 'top' as const };

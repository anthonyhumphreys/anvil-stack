import { MaterialIcons } from '@react-native-vector-icons/material-icons';
import { Image } from 'expo-image';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  RefreshControl,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type TextStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  EmptyState,
  Panel,
  bodyStyle,
  companionColors,
  monoStyle,
  screenStyle,
  subtleStyle,
  titleStyle,
} from '@/components/companion-ui';
import { useCompanion } from '@/contexts/companion-context';
import { chatAttachmentUrl, type CompanionConnection } from '@/lib/anvil-api';
import { threadHref } from '@/lib/routes';
import type {
  ChatAttachment,
  ChatAttachmentInput,
  ChatCollaborationMode,
  ChatFileMentionSearchResult,
  ChatMessage,
  CodexRegisteredSkill,
  ReasoningEffort,
} from '../../src/shared/types';

type IconName = ComponentProps<typeof MaterialIcons>['name'];

const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

interface OptimisticMessage {
  id: string;
  content: string;
  timestamp: string;
  state: 'sending' | 'failed';
  input: {
    message: string;
    attachments: ChatAttachmentInput[];
    collaborationMode: ChatCollaborationMode;
    reasoningEffort: ReasoningEffort;
  };
}

type TimelineMessage =
  | { kind: 'persisted'; message: ChatMessage }
  | { kind: 'optimistic'; message: OptimisticMessage };

export default function ChatThreadScreen() {
  const { threadId } = useLocalSearchParams<{ threadId: string }>();
  const {
    threads,
    selectedThreadHistory,
    loading,
    error,
    refresh,
    selectThread,
    sendMessage,
    startWorkflow,
    interrupt,
    searchFiles,
    searchSkills,
    connection,
  } = useCompanion();
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList<TimelineMessage> | null>(null);
  const nearBottomRef = useRef(true);
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [mode, setMode] = useState<ChatCollaborationMode>('default');
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('medium');
  const [attachments, setAttachments] = useState<ChatAttachmentInput[]>([]);
  const [pickingAttachment, setPickingAttachment] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [fileSuggestions, setFileSuggestions] = useState<ChatFileMentionSearchResult[]>([]);
  const [skillSuggestions, setSkillSuggestions] = useState<CodexRegisteredSkill[]>([]);
  const [optimisticMessages, setOptimisticMessages] = useState<OptimisticMessage[]>([]);

  const thread = threads.find((candidate) => candidate.id === threadId);
  const visibleMessages = useMemo<TimelineMessage[]>(
    () => [
      ...selectedThreadHistory.map((message) => ({ kind: 'persisted' as const, message })),
      ...optimisticMessages.map((message) => ({ kind: 'optimistic' as const, message })),
    ],
    [optimisticMessages, selectedThreadHistory],
  );

  useEffect(() => {
    if (threadId) void selectThread(threadId);
  }, [selectThread, threadId]);

  useEffect(() => {
    if (!threadId || !thread?.activeSessionId) return;
    const interval = setInterval(() => void selectThread(threadId), 2_000);
    return () => clearInterval(interval);
  }, [selectThread, thread?.activeSessionId, threadId]);

  const activeTrigger = useMemo(() => activeComposerTrigger(draft), [draft]);

  useEffect(() => {
    let cancelled = false;
    const loadSuggestions = async () => {
      if (!activeTrigger || !thread) {
        setFileSuggestions([]);
        setSkillSuggestions([]);
        return;
      }
      if (activeTrigger.kind === 'file') {
        setSkillSuggestions([]);
        const repoIds = thread.repoIds ?? [];
        if (repoIds.length === 0) {
          setFileSuggestions([]);
          return;
        }
        const results = await searchFiles({
          repoIds,
          query: activeTrigger.query,
          limit: 8,
        });
        if (!cancelled) setFileSuggestions(results);
        return;
      }
      setFileSuggestions([]);
      const results = await searchSkills(activeTrigger.query);
      if (!cancelled) setSkillSuggestions(results.slice(0, 8));
    };
    const timer = setTimeout(() => void loadSuggestions(), 160);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [activeTrigger, searchFiles, searchSkills, thread]);

  const reloadThread = async () => {
    await refresh();
    if (threadId) await selectThread(threadId);
  };

  const sendOptimisticMessage = async (optimistic: OptimisticMessage) => {
    if (!thread) return;
    setOptimisticMessages((current) =>
      current.map((message) =>
        message.id === optimistic.id ? { ...message, state: 'sending' } : message,
      ),
    );
    try {
      if (thread.activeSessionId) {
        await sendMessage(thread.id, thread.activeSessionId, optimistic.input);
      } else {
        const result = await startWorkflow({
          ...optimistic.input,
          title: thread.title,
          personaId: thread.personaId,
          workspaceId: thread.workspaceId,
          repoIds: thread.repoIds ?? [],
        });
        if (!result) throw new Error('Anvil could not start this run.');
        if (result.thread.id !== thread.id) router.replace(threadHref(result.thread.id));
      }
      setOptimisticMessages((current) => current.filter((message) => message.id !== optimistic.id));
    } catch {
      setOptimisticMessages((current) =>
        current.map((message) =>
          message.id === optimistic.id ? { ...message, state: 'failed' } : message,
        ),
      );
    }
  };

  const submit = async () => {
    if (!thread || (!draft.trim() && attachments.length === 0)) return;
    const message = draft.trim() || attachmentOnlyMessage(attachments);
    const optimistic: OptimisticMessage = {
      id: `optimistic:${Date.now()}`,
      content: message,
      timestamp: new Date().toISOString(),
      state: 'sending',
      input: {
        message,
        attachments: [...attachments],
        collaborationMode: mode,
        reasoningEffort,
      },
    };
    setSubmitting(true);
    setAttachmentError(null);
    setDraft('');
    setAttachments([]);
    setOptimisticMessages((current) => [...current, optimistic]);
    nearBottomRef.current = true;
    await sendOptimisticMessage(optimistic);
    setSubmitting(false);
  };

  const openComposerMenu = () => {
    Alert.alert('Chat options', 'Add context or tune this run.', [
      { text: 'Add file', onPress: () => void pickFiles() },
      { text: 'Add photo', onPress: () => void pickPhotos() },
      {
        text: mode === 'plan' ? 'Switch to Build' : 'Switch to Plan',
        onPress: () => setMode((current) => (current === 'plan' ? 'default' : 'plan')),
      },
      {
        text: `Reasoning: ${reasoningEffort}`,
        onPress: () => setReasoningEffort(nextReasoningEffort(reasoningEffort)),
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const handleTimelineScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    nearBottomRef.current = contentSize.height - layoutMeasurement.height - contentOffset.y < 140;
  }, []);

  const selectFileSuggestion = (file: ChatFileMentionSearchResult) => {
    setAttachments((current) =>
      current.some((attachment) => attachment.path === file.path)
        ? current
        : [
            ...current,
            {
              id: `workspace:${file.repoId}:${file.path}`,
              name: file.name,
              path: file.path,
              size: file.size,
            },
          ],
    );
    setDraft((current) => replaceActiveTrigger(current, `@${file.relativePath} `));
    setFileSuggestions([]);
  };

  const pickPhotos = async () => {
    const [Haptics, ImagePicker] = await Promise.all([
      import('expo-haptics'),
      import('expo-image-picker'),
    ]);
    await Haptics.selectionAsync();
    setPickingAttachment(true);
    setAttachmentError(null);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        quality: 0.86,
        base64: false,
      });
      if (result.canceled) return;
      const nextAttachments = await Promise.all(
        result.assets.map((asset, index) =>
          attachmentFromUri({
            uri: asset.uri,
            name: asset.fileName ?? `photo-${Date.now()}-${index + 1}.jpg`,
            mimeType: asset.mimeType ?? 'image/jpeg',
            size: asset.fileSize,
          }),
        ),
      );
      appendAttachments(nextAttachments);
    } catch (err) {
      setAttachmentError(errorMessage(err));
    } finally {
      setPickingAttachment(false);
    }
  };

  const pickFiles = async () => {
    const [DocumentPicker, Haptics] = await Promise.all([
      import('expo-document-picker'),
      import('expo-haptics'),
    ]);
    await Haptics.selectionAsync();
    setPickingAttachment(true);
    setAttachmentError(null);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const nextAttachments = await Promise.all(
        result.assets.map((asset) =>
          attachmentFromUri({
            uri: asset.uri,
            name: asset.name,
            mimeType: asset.mimeType ?? 'application/octet-stream',
            size: asset.size,
          }),
        ),
      );
      appendAttachments(nextAttachments);
    } catch (err) {
      setAttachmentError(errorMessage(err));
    } finally {
      setPickingAttachment(false);
    }
  };

  const appendAttachments = (nextAttachments: ChatAttachmentInput[]) => {
    if (nextAttachments.length === 0) return;
    setAttachments((current) => {
      const existingKeys = new Set(current.map(attachmentKey));
      const deduped = nextAttachments.filter(
        (attachment) => !existingKeys.has(attachmentKey(attachment)),
      );
      const availableSlots = MAX_ATTACHMENT_COUNT - current.length;
      if (availableSlots <= 0) {
        setAttachmentError(`Attach up to ${MAX_ATTACHMENT_COUNT} files at a time.`);
        return current;
      }
      const accepted = deduped.slice(0, availableSlots);
      if (accepted.length < deduped.length) {
        setAttachmentError(
          `Some files were skipped. Attach up to ${MAX_ATTACHMENT_COUNT} files at a time.`,
        );
      }
      return [...current, ...accepted];
    });
  };

  const selectSkillSuggestion = (skill: CodexRegisteredSkill) => {
    setDraft((current) => replaceActiveTrigger(current, `$${skill.name} `));
    setSkillSuggestions([]);
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: thread?.title ?? 'Thread',
        }}
      />
      <KeyboardAvoidingView
        style={[screenStyle, { flex: 1 }]}
        behavior={process.env.EXPO_OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={92}
      >
        <FlatList
          ref={listRef}
          data={visibleMessages}
          keyExtractor={(item) => item.message.id}
          style={{ flex: 1 }}
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          onScroll={handleTimelineScroll}
          scrollEventThrottle={80}
          onContentSizeChange={() => {
            if (nearBottomRef.current) listRef.current?.scrollToEnd({ animated: true });
          }}
          refreshControl={
            <RefreshControl refreshing={loading} onRefresh={() => void reloadThread()} />
          }
          contentContainerStyle={threadContentStyle}
          ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
          ListHeaderComponent={
            !thread || error || thread.pendingApprovalCount > 0 ? (
              <View style={{ gap: 8, paddingBottom: 12 }}>
                {!thread && <MissingThread />}
                {thread?.pendingApprovalCount ? (
                  <TouchableOpacity
                    accessibilityRole="button"
                    onPress={() => router.push('/(tabs)/approvals')}
                    style={approvalNoticeStyle}
                  >
                    <MaterialIcons name="priority-high" size={18} color={companionColors.red} />
                    <Text style={approvalNoticeTextStyle}>
                      {thread.pendingApprovalCount} approval
                      {thread.pendingApprovalCount === 1 ? '' : 's'} waiting
                    </Text>
                  </TouchableOpacity>
                ) : null}
                {error && (
                  <Text selectable accessibilityLiveRegion="polite" style={errorTextStyle}>
                    {error}
                  </Text>
                )}
              </View>
            ) : null
          }
          ListEmptyComponent={
            <EmptyState
              title="No messages loaded"
              body={thread?.preview || 'Pull to refresh this thread.'}
            />
          }
          renderItem={({ item }) =>
            item.kind === 'persisted' ? (
              <MessageBubble message={item.message} connection={connection} />
            ) : (
              <OptimisticBubble
                message={item.message}
                onRetry={() => void sendOptimisticMessage(item.message)}
              />
            )
          }
        />

        <View style={[composerBarStyle, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          {attachments.length > 0 && (
            <View style={attachmentChipRowStyle}>
              {attachments.map((attachment) => (
                <TouchableOpacity
                  key={attachmentKey(attachment)}
                  activeOpacity={0.72}
                  onPress={() =>
                    setAttachments((current) =>
                      current.filter(
                        (candidate) => attachmentKey(candidate) !== attachmentKey(attachment),
                      ),
                    )
                  }
                  style={attachmentChipStyle}
                >
                  <MaterialIcons
                    name={attachmentIcon(attachment)}
                    size={14}
                    color={companionColors.blue}
                  />
                  <Text numberOfLines={1} style={attachmentChipTextStyle}>
                    {attachment.name}
                  </Text>
                  <MaterialIcons name="close" size={13} color={companionColors.subtle} />
                </TouchableOpacity>
              ))}
            </View>
          )}
          {attachmentError && (
            <Text selectable style={[subtleStyle, { color: companionColors.red }]}>
              {attachmentError}
            </Text>
          )}
          {(fileSuggestions.length > 0 || skillSuggestions.length > 0) && (
            <View style={suggestionPanelStyle}>
              {fileSuggestions.map((file) => (
                <TouchableOpacity
                  key={`${file.repoId}:${file.relativePath}`}
                  activeOpacity={0.76}
                  onPress={() => selectFileSuggestion(file)}
                  style={suggestionRowStyle}
                >
                  <MaterialIcons name="description" size={16} color={companionColors.blue} />
                  <View style={{ flex: 1 }}>
                    <Text numberOfLines={1} style={suggestionTitleStyle}>
                      {file.name}
                    </Text>
                    <Text numberOfLines={1} style={suggestionDetailStyle}>
                      {file.repoName} / {file.relativePath}
                    </Text>
                  </View>
                  <Text style={suggestionHintStyle}>attach</Text>
                </TouchableOpacity>
              ))}
              {skillSuggestions.map((skill) => (
                <TouchableOpacity
                  key={skill.id}
                  activeOpacity={0.76}
                  onPress={() => selectSkillSuggestion(skill)}
                  style={suggestionRowStyle}
                >
                  <MaterialIcons name="auto-awesome" size={16} color={companionColors.purple} />
                  <View style={{ flex: 1 }}>
                    <Text numberOfLines={1} style={suggestionTitleStyle}>
                      ${skill.name}
                    </Text>
                    {skill.description && (
                      <Text numberOfLines={1} style={suggestionDetailStyle}>
                        {skill.description}
                      </Text>
                    )}
                  </View>
                  <Text style={suggestionHintStyle}>insert</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
          <View style={composerShellStyle}>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Chat options"
              activeOpacity={0.72}
              onPress={openComposerMenu}
              disabled={pickingAttachment || attachments.length >= MAX_ATTACHMENT_COUNT}
              style={[composerIconButtonStyle, pickingAttachment && disabledToolButtonStyle]}
            >
              <MaterialIcons name="add" size={22} color={companionColors.ink} />
            </TouchableOpacity>
            <View style={{ flex: 1, minWidth: 0 }}>
              <TextInput
                accessibilityLabel="Message"
                value={draft}
                onChangeText={setDraft}
                placeholder={thread?.activeSessionId ? 'Message Anvil…' : 'Start a run…'}
                placeholderTextColor={companionColors.faint}
                multiline
                style={composerInputStyle}
              />
              <Text style={composerContextStyle}>
                {mode === 'plan' ? 'Plan' : 'Build'} · {reasoningEffort}
              </Text>
            </View>
            {thread?.activeSessionId && (
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Stop run"
                activeOpacity={0.72}
                onPress={() => void interrupt(thread.activeSessionId!)}
                style={composerIconButtonStyle}
              >
                <MaterialIcons name="stop" size={20} color={companionColors.red} />
              </TouchableOpacity>
            )}
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={thread?.activeSessionId ? 'Send message' : 'Launch run'}
              accessibilityState={{
                disabled: submitting || (!draft.trim() && attachments.length === 0),
              }}
              activeOpacity={0.72}
              onPress={() => void submit()}
              disabled={submitting || (!draft.trim() && attachments.length === 0)}
              style={[sendIconButtonStyle, submitting && disabledToolButtonStyle]}
            >
              <MaterialIcons name="arrow-upward" size={20} color={companionColors.onDark} />
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </>
  );
}

function MissingThread() {
  return (
    <Panel compact>
      <Text style={titleStyle}>Thread unavailable</Text>
      <Text style={bodyStyle}>Refresh chats or go back to choose a current thread.</Text>
    </Panel>
  );
}

function MessageBubble({
  message,
  connection,
}: {
  message: ChatMessage;
  connection: CompanionConnection | null;
}) {
  const user = message.role === 'user';
  const system = message.role === 'system';
  const hasMetadata = Boolean(message.repoContext || message.citations?.length);

  return (
    <View style={[messageBubbleStyle, user && userBubbleStyle, system && systemBubbleStyle]}>
      <View style={messageHeaderStyle}>
        <Text style={[messageRoleStyle, user && userRoleStyle]}>{user ? 'you' : message.role}</Text>
        <Text style={messageTimeStyle}>{relativeTime(message.timestamp)}</Text>
      </View>
      {message.repoContext && (
        <Text selectable numberOfLines={2} style={monoStyle}>
          {message.repoContext}
        </Text>
      )}
      <MarkdownBody content={message.content} />
      {message.attachments?.length ? (
        <MessageAttachmentGrid attachments={message.attachments} connection={connection} />
      ) : null}
      {hasMetadata && (
        <View style={messageMetaStyle}>
          {message.citations?.length ? (
            <Text style={messageMetaTextStyle}>{message.citations.length} citations</Text>
          ) : null}
        </View>
      )}
    </View>
  );
}

function OptimisticBubble({
  message,
  onRetry,
}: {
  message: OptimisticMessage;
  onRetry: () => void;
}) {
  return (
    <View
      style={[messageBubbleStyle, userBubbleStyle, message.state === 'failed' && failedBubbleStyle]}
    >
      <MarkdownBody content={message.content} />
      <View style={optimisticStatusStyle}>
        <Text accessibilityLiveRegion="polite" style={messageTimeStyle}>
          {message.state === 'sending' ? 'Sending…' : 'Not sent'}
        </Text>
        {message.state === 'failed' && (
          <TouchableOpacity accessibilityRole="button" onPress={onRetry} hitSlop={8}>
            <Text style={retryTextStyle}>Retry</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

function MarkdownBody({ content }: { content: string }) {
  const blocks = parseMarkdownBlocks(content);
  return (
    <View style={{ gap: 8 }}>
      {blocks.map((block, index) => {
        if (block.kind === 'code') {
          return (
            <View key={`${index}:${block.content.slice(0, 12)}`} style={codeBlockStyle}>
              {block.language ? <Text style={codeLanguageStyle}>{block.language}</Text> : null}
              <Text selectable style={codeTextStyle}>
                {block.content}
              </Text>
            </View>
          );
        }
        if (block.kind === 'heading') {
          return (
            <Text key={`${index}:${block.content}`} selectable style={markdownHeadingStyle}>
              {renderInlineMarkdown(block.content)}
            </Text>
          );
        }
        if (block.kind === 'list') {
          return (
            <View key={`${index}:${block.content}`} style={markdownListRowStyle}>
              <Text style={markdownBulletStyle}>•</Text>
              <Text selectable style={[messageTextStyle, { flex: 1 }]}>
                {renderInlineMarkdown(block.content)}
              </Text>
            </View>
          );
        }
        return (
          <Text key={`${index}:${block.content.slice(0, 12)}`} selectable style={messageTextStyle}>
            {renderInlineMarkdown(block.content)}
          </Text>
        );
      })}
    </View>
  );
}

type MarkdownBlock = {
  kind: 'paragraph' | 'heading' | 'list' | 'code';
  content: string;
  language?: string;
};

function parseMarkdownBlocks(content: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = content.split('\n');
  let paragraph: string[] = [];
  let code: string[] | null = null;
  let language = '';
  const flushParagraph = () => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', content: paragraph.join('\n') });
    paragraph = [];
  };
  for (const line of lines) {
    if (line.startsWith('```')) {
      if (code) {
        blocks.push({ kind: 'code', content: code.join('\n'), language });
        code = null;
        language = '';
      } else {
        flushParagraph();
        code = [];
        language = line.slice(3).trim();
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    const heading = line.match(/^#{1,3}\s+(.+)/);
    const list = line.match(/^\s*[-*]\s+(.+)/);
    if (heading || list || !line.trim()) {
      flushParagraph();
      if (heading) blocks.push({ kind: 'heading', content: heading[1] });
      if (list) blocks.push({ kind: 'list', content: list[1] });
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  if (code) blocks.push({ kind: 'code', content: code.join('\n'), language });
  return blocks;
}

function renderInlineMarkdown(content: string) {
  return content.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <Text key={index} style={inlineCodeStyle}>
          {part.slice(1, -1)}
        </Text>
      );
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <Text key={index} style={{ fontWeight: '800' }}>
          {part.slice(2, -2)}
        </Text>
      );
    }
    return part;
  });
}

function MessageAttachmentGrid({
  attachments,
  connection,
}: {
  attachments: ChatAttachment[];
  connection: CompanionConnection | null;
}) {
  return (
    <View style={messageAttachmentGridStyle}>
      {attachments.map((attachment) => (
        <MessageAttachmentCard
          key={attachment.id}
          attachment={attachment}
          connection={connection}
        />
      ))}
    </View>
  );
}

function MessageAttachmentCard({
  attachment,
  connection,
}: {
  attachment: ChatAttachment;
  connection: CompanionConnection | null;
}) {
  const isImage = attachment.kind === 'image' && connection;
  return (
    <View style={messageAttachmentCardStyle}>
      {isImage ? (
        <Image
          source={{
            uri: chatAttachmentUrl(connection, attachment.id),
            headers: { Authorization: `Bearer ${connection.token}` },
          }}
          contentFit="cover"
          transition={140}
          style={messageAttachmentImageStyle}
        />
      ) : (
        <View style={messageAttachmentIconStyle}>
          <MaterialIcons
            name={attachment.kind === 'image' ? 'image' : attachmentIcon(attachment)}
            size={22}
            color={companionColors.blue}
          />
        </View>
      )}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text selectable numberOfLines={1} style={messageAttachmentTitleStyle}>
          {attachment.name}
        </Text>
        <Text numberOfLines={1} style={messageAttachmentDetailStyle}>
          {formatBytes(attachment.size)} / {attachment.mimeType || 'file'}
        </Text>
      </View>
    </View>
  );
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

function activeComposerTrigger(value: string): { kind: 'file' | 'skill'; query: string } | null {
  const match = value.match(/(?:^|\s)([@$])([^\s@$]*)$/);
  if (!match) return null;
  return {
    kind: match[1] === '@' ? 'file' : 'skill',
    query: match[2] ?? '',
  };
}

function replaceActiveTrigger(value: string, replacement: string): string {
  return value.replace(/(^|\s)([@$])([^\s@$]*)$/, (_match, prefix: string) => {
    return `${prefix}${replacement}`;
  });
}

async function attachmentFromUri(input: {
  uri: string;
  name: string;
  mimeType: string;
  size?: number | null;
}): Promise<ChatAttachmentInput> {
  const FileSystem = await import('expo-file-system/legacy');
  const fileInfo = await FileSystem.getInfoAsync(input.uri);
  const size = input.size ?? (fileInfo.exists ? fileInfo.size : undefined);
  if (typeof size === 'number' && size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${input.name} is larger than ${formatBytes(MAX_ATTACHMENT_BYTES)}.`);
  }

  const base64 = await FileSystem.readAsStringAsync(input.uri, {
    encoding: FileSystem.EncodingType.Base64,
  });

  return {
    id: `mobile:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    name: input.name,
    mimeType: input.mimeType,
    size,
    dataUrl: `data:${input.mimeType};base64,${base64}`,
  };
}

function attachmentKey(attachment: ChatAttachmentInput): string {
  return attachment.id ?? attachment.path ?? `${attachment.name}:${attachment.size ?? 0}`;
}

function attachmentIcon(attachment: ChatAttachmentInput): IconName {
  if (attachment.mimeType?.startsWith('image/')) return 'image';
  if (attachment.mimeType === 'application/pdf') return 'picture-as-pdf';
  return 'attach-file';
}

function attachmentOnlyMessage(attachments: ChatAttachmentInput[]): string {
  const imageCount = attachments.filter((attachment) =>
    (attachment.mimeType ?? '').startsWith('image/'),
  ).length;
  if (imageCount === attachments.length) {
    return `Review ${attachments.length === 1 ? 'this image' : 'these images'}.`;
  }
  return `Review ${attachments.length === 1 ? 'this file' : 'these files'}.`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'The picker returned an unreadable file.';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

function nextReasoningEffort(value: ReasoningEffort): ReasoningEffort {
  if (value === 'low') return 'medium';
  if (value === 'medium') return 'high';
  return 'low';
}

const threadContentStyle = { padding: 16, paddingBottom: 18, flexGrow: 1 };
const messageBubbleStyle = {
  maxWidth: '94%' as const,
  alignSelf: 'flex-start' as const,
  backgroundColor: companionColors.surface,
  borderColor: companionColors.borderSubtle,
  borderWidth: 1,
  borderRadius: 8,
  padding: 12,
  gap: 8,
};
const userBubbleStyle = {
  alignSelf: 'flex-end' as const,
  backgroundColor: companionColors.cyanSoft,
  borderColor: companionColors.cyanBorder,
};
const failedBubbleStyle = { borderColor: companionColors.redBorder };
const systemBubbleStyle = {
  maxWidth: '100%' as const,
  alignSelf: 'stretch' as const,
  backgroundColor: companionColors.surfaceMuted,
};
const messageHeaderStyle = {
  flexDirection: 'row' as const,
  justifyContent: 'space-between' as const,
  alignItems: 'center' as const,
  gap: 10,
};
const messageRoleStyle = {
  color: companionColors.subtle,
  fontWeight: '800' as const,
  fontSize: 12,
};
const userRoleStyle = { color: companionColors.blue };
const messageTimeStyle = {
  color: companionColors.faint,
  fontSize: 12,
  fontVariant: ['tabular-nums'],
} satisfies TextStyle;
const messageTextStyle = { color: companionColors.ink, lineHeight: 20, fontSize: 15 };
const markdownHeadingStyle = {
  color: companionColors.ink,
  fontSize: 17,
  lineHeight: 22,
  fontWeight: '900' as const,
};
const markdownListRowStyle = {
  flexDirection: 'row' as const,
  gap: 8,
  alignItems: 'flex-start' as const,
};
const markdownBulletStyle = { color: companionColors.subtle, fontSize: 17, lineHeight: 20 };
const codeBlockStyle = {
  padding: 11,
  gap: 6,
  borderRadius: 8,
  borderCurve: 'continuous' as const,
  backgroundColor: companionColors.dark,
};
const codeLanguageStyle = {
  color: companionColors.darkMuted,
  fontSize: 11,
  fontWeight: '800' as const,
  textTransform: 'uppercase' as const,
};
const codeTextStyle = {
  color: companionColors.onDark,
  fontFamily: 'Menlo',
  fontSize: 13,
  lineHeight: 19,
};
const inlineCodeStyle = {
  color: companionColors.ink,
  fontFamily: 'Menlo',
  fontSize: 13,
  backgroundColor: companionColors.surfaceMuted,
};
const optimisticStatusStyle = {
  flexDirection: 'row' as const,
  justifyContent: 'flex-end' as const,
  alignItems: 'center' as const,
  gap: 12,
};
const retryTextStyle = { color: companionColors.red, fontSize: 12, fontWeight: '900' as const };
const messageAttachmentGridStyle = {
  gap: 8,
};
const messageAttachmentCardStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 10,
  borderColor: companionColors.borderSubtle,
  borderWidth: 1,
  borderRadius: 8,
  padding: 8,
  backgroundColor: companionColors.surfaceMuted,
};
const messageAttachmentImageStyle = {
  width: 56,
  height: 56,
  borderRadius: 7,
  backgroundColor: companionColors.surface,
};
const messageAttachmentIconStyle = {
  width: 42,
  height: 42,
  borderRadius: 8,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  backgroundColor: companionColors.blueSoft,
};
const messageAttachmentTitleStyle = {
  color: companionColors.ink,
  fontSize: 13,
  fontWeight: '900' as const,
};
const messageAttachmentDetailStyle = {
  color: companionColors.subtle,
  fontSize: 12,
};
const messageMetaStyle = {
  flexDirection: 'row' as const,
  gap: 8,
  flexWrap: 'wrap' as const,
};
const messageMetaTextStyle = {
  color: companionColors.subtle,
  fontSize: 12,
  fontWeight: '700' as const,
};
const composerBarStyle = {
  backgroundColor: companionColors.surface,
  borderTopColor: companionColors.borderSubtle,
  borderTopWidth: 1,
  paddingHorizontal: 12,
  paddingTop: 10,
  gap: 8,
};
const attachmentChipRowStyle = {
  flexDirection: 'row' as const,
  gap: 6,
  flexWrap: 'wrap' as const,
};
const attachmentChipStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 4,
  maxWidth: '48%' as const,
  borderColor: companionColors.blueBorder,
  borderWidth: 1,
  borderRadius: 999,
  paddingHorizontal: 9,
  paddingVertical: 6,
  backgroundColor: companionColors.blueSoft,
};
const attachmentChipTextStyle = {
  flexShrink: 1,
  color: companionColors.blue,
  fontSize: 12,
  fontWeight: '800' as const,
};
const suggestionPanelStyle = {
  borderWidth: 1,
  borderColor: companionColors.borderSubtle,
  borderRadius: 8,
  backgroundColor: companionColors.surface,
  overflow: 'hidden' as const,
};
const suggestionRowStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 9,
  paddingHorizontal: 10,
  paddingVertical: 9,
  borderBottomColor: companionColors.borderSubtle,
  borderBottomWidth: 1,
};
const suggestionTitleStyle = {
  color: companionColors.ink,
  fontSize: 13,
  fontWeight: '900' as const,
};
const suggestionDetailStyle = {
  color: companionColors.subtle,
  fontSize: 12,
};
const suggestionHintStyle = {
  color: companionColors.faint,
  fontSize: 11,
  fontWeight: '900' as const,
};
const composerInputStyle = {
  minHeight: 44,
  maxHeight: 112,
  paddingHorizontal: 4,
  paddingTop: 10,
  paddingBottom: 2,
  color: companionColors.ink,
  fontSize: 16,
  textAlignVertical: 'center' as const,
};
const composerShellStyle = {
  flexDirection: 'row' as const,
  alignItems: 'flex-end' as const,
  gap: 6,
  borderWidth: 1,
  borderColor: companionColors.border,
  borderRadius: 22,
  borderCurve: 'continuous' as const,
  padding: 5,
  backgroundColor: companionColors.surfaceMuted,
};
const composerIconButtonStyle = {
  width: 38,
  height: 38,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  borderRadius: 19,
};
const sendIconButtonStyle = {
  width: 38,
  height: 38,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  borderRadius: 19,
  backgroundColor: companionColors.dark,
};
const composerContextStyle = {
  paddingHorizontal: 4,
  paddingBottom: 5,
  color: companionColors.subtle,
  fontSize: 11,
  textTransform: 'capitalize' as const,
};
const disabledToolButtonStyle = { opacity: 0.5 };
const approvalNoticeStyle = {
  minHeight: 44,
  paddingHorizontal: 12,
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 8,
  borderRadius: 10,
  backgroundColor: companionColors.redSoft,
};
const approvalNoticeTextStyle = { flex: 1, color: companionColors.red, fontWeight: '800' as const };
const errorTextStyle = { ...subtleStyle, color: companionColors.red };

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Image } from 'expo-image';
import { Stack, router, useLocalSearchParams, type RelativePathString } from 'expo-router';
import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import {
  KeyboardAvoidingView,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type TextStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ActionButton,
  BlockedNotice,
  EmptyState,
  Panel,
  StatusPill,
  bodyStyle,
  companionColors,
  inputStyle,
  monoStyle,
  screenStyle,
  subtleStyle,
  titleStyle,
} from '@/components/companion-ui';
import { useCompanion } from '@/contexts/companion-context';
import { chatAttachmentUrl, type CompanionConnection } from '@/lib/anvil-api';
import type {
  ChatAttachment,
  ChatAttachmentInput,
  ChatCollaborationMode,
  ChatFileMentionSearchResult,
  ChatMessage,
  CodexRegisteredSkill,
  MobileChatThreadSummary,
  ReasoningEffort,
} from '../../../../src/shared/types';

type IconName = ComponentProps<typeof MaterialIcons>['name'];

const REASONING_LEVELS: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

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
  const scrollRef = useRef<ScrollView | null>(null);
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [mode, setMode] = useState<ChatCollaborationMode>('default');
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('medium');
  const [attachments, setAttachments] = useState<ChatAttachmentInput[]>([]);
  const [pickingAttachment, setPickingAttachment] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [fileSuggestions, setFileSuggestions] = useState<ChatFileMentionSearchResult[]>([]);
  const [skillSuggestions, setSkillSuggestions] = useState<CodexRegisteredSkill[]>([]);

  const thread = threads.find((candidate) => candidate.id === threadId);
  const visibleMessages = useMemo(() => selectedThreadHistory, [selectedThreadHistory]);

  useEffect(() => {
    if (threadId) void selectThread(threadId);
  }, [selectThread, threadId]);

  useEffect(() => {
    const timer = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 120);
    return () => clearTimeout(timer);
  }, [visibleMessages.length]);

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

  const submit = async () => {
    if (!thread || (!draft.trim() && attachments.length === 0)) return;
    const message = draft.trim() || attachmentOnlyMessage(attachments);
    setDraft('');
    setSubmitting(true);
    setAttachmentError(null);
    if (thread.activeSessionId) {
      await sendMessage(thread.id, thread.activeSessionId, {
        message,
        attachments,
        collaborationMode: mode,
        reasoningEffort,
      });
    } else {
      const result = await startWorkflow({
        message,
        title: thread.title,
        personaId: thread.personaId,
        workspaceId: thread.workspaceId,
        repoIds: thread.repoIds ?? [],
        attachments,
        collaborationMode: mode,
        reasoningEffort,
      });
      if (result?.thread.id && result.thread.id !== thread.id) {
        router.replace(threadHref(result.thread.id));
      }
    }
    setAttachments([]);
    setSubmitting(false);
  };

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
          headerRight: thread?.activeSessionId
            ? () => (
                <TouchableOpacity
                  activeOpacity={0.72}
                  onPress={() => void interrupt(thread.activeSessionId!)}
                  style={headerButtonStyle}
                >
                  <MaterialIcons name="stop-circle" size={22} color={companionColors.red} />
                </TouchableOpacity>
              )
            : undefined,
        }}
      />
      <KeyboardAvoidingView
        style={[screenStyle, { flex: 1 }]}
        behavior={process.env.EXPO_OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={92}
      >
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentInsetAdjustmentBehavior="automatic"
          refreshControl={
            <RefreshControl refreshing={loading} onRefresh={() => void reloadThread()} />
          }
          contentContainerStyle={[threadContentStyle, { paddingBottom: 18 }]}
        >
          {thread ? <ThreadBrief thread={thread} /> : <MissingThread />}

          {error && (
            <Text selectable style={[subtleStyle, { color: companionColors.red }]}>
              {error}
            </Text>
          )}

          {visibleMessages.length === 0 ? (
            <EmptyState
              title="No messages loaded"
              body={thread?.preview || 'Pull to refresh this thread.'}
            />
          ) : (
            <View style={messageListStyle}>
              {visibleMessages.map((message) => (
                <MessageBubble key={message.id} message={message} connection={connection} />
              ))}
            </View>
          )}
        </ScrollView>

        <View style={[composerBarStyle, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          <View style={controlRowStyle}>
            <SegmentedControl
              value={mode}
              options={[
                { value: 'default', label: 'Build' },
                { value: 'plan', label: 'Plan' },
              ]}
              onChange={(next) => setMode(next as ChatCollaborationMode)}
            />
            <View style={reasoningRowStyle}>
              {REASONING_LEVELS.map((level) => (
                <TouchableOpacity
                  key={level}
                  activeOpacity={0.72}
                  onPress={() => setReasoningEffort(level)}
                  style={[
                    reasoningChipStyle,
                    reasoningEffort === level && reasoningChipActiveStyle,
                  ]}
                >
                  <Text
                    style={[
                      reasoningChipTextStyle,
                      reasoningEffort === level && reasoningChipTextActiveStyle,
                    ]}
                  >
                    {level === 'minimal' ? 'min' : level}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
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
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={
              thread?.activeSessionId
                ? 'Steer the run. Use @files or $skills…'
                : 'Start a run. Use @files or $skills…'
            }
            placeholderTextColor={companionColors.faint}
            multiline
            style={[inputStyle, composerInputStyle]}
          />
          <View style={composerActionRowStyle}>
            <TouchableOpacity
              activeOpacity={0.72}
              onPress={() => void pickFiles()}
              disabled={pickingAttachment || attachments.length >= MAX_ATTACHMENT_COUNT}
              style={[composerToolButtonStyle, pickingAttachment && disabledToolButtonStyle]}
            >
              <MaterialIcons name="attach-file" size={18} color={companionColors.ink} />
              <Text style={composerToolButtonTextStyle}>File</Text>
            </TouchableOpacity>
            <TouchableOpacity
              activeOpacity={0.72}
              onPress={() => void pickPhotos()}
              disabled={pickingAttachment || attachments.length >= MAX_ATTACHMENT_COUNT}
              style={[composerToolButtonStyle, pickingAttachment && disabledToolButtonStyle]}
            >
              <MaterialIcons name="image" size={18} color={companionColors.ink} />
              <Text style={composerToolButtonTextStyle}>Photo</Text>
            </TouchableOpacity>
            <Text numberOfLines={1} style={composerHintStyle}>
              @ workspace files, $ skills
            </Text>
          </View>
          <ActionButton
            label={submitting ? 'Sending…' : thread?.activeSessionId ? 'Send' : 'Launch'}
            onPress={() => void submit()}
            disabled={!thread || (!draft.trim() && attachments.length === 0) || submitting}
            style={sendButtonStyle}
          />
        </View>
      </KeyboardAvoidingView>
    </>
  );
}

function ThreadBrief({ thread }: { thread: MobileChatThreadSummary }) {
  const status = threadStatus(thread);
  return (
    <Panel compact style={threadBriefStyle}>
      <View style={threadBriefHeaderStyle}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text selectable style={titleStyle}>
            {thread.title}
          </Text>
          <Text style={subtleStyle}>
            {thread.personaId} / {thread.messageCount} messages / {relativeTime(thread.updatedAt)}
          </Text>
        </View>
        <StatusPill label={status.label} color={status.color} background={status.background} />
      </View>
      {thread.preview && (
        <Text selectable numberOfLines={3} style={bodyStyle}>
          {thread.preview}
        </Text>
      )}
      {thread.pendingApprovalCount > 0 && (
        <BlockedNotice
          body={`${thread.pendingApprovalCount} approval${thread.pendingApprovalCount === 1 ? '' : 's'} waiting. Open Approvals if the run is blocked.`}
        />
      )}
    </Panel>
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
      <Text selectable style={messageTextStyle}>
        {message.content}
      </Text>
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
          source={chatAttachmentUrl(connection, attachment.id)}
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

function threadStatus(thread: MobileChatThreadSummary) {
  if (thread.pendingApprovalCount > 0) {
    return {
      label: 'blocked',
      color: companionColors.red,
      background: companionColors.redSoft,
    };
  }
  if (thread.activeSessionId) {
    return {
      label: thread.activeSessionStatus ?? 'live',
      color: companionColors.blue,
      background: companionColors.blueSoft,
    };
  }
  return { label: 'ready', color: companionColors.green, background: companionColors.greenSoft };
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

function threadHref(nextThreadId: string): RelativePathString {
  return `/(tabs)/chats/${encodeURIComponent(nextThreadId)}` as RelativePathString;
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

function SegmentedControl({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <View style={segmentedStyle}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <TouchableOpacity
            key={option.value}
            activeOpacity={0.74}
            onPress={() => onChange(option.value)}
            style={[segmentStyle, selected && segmentActiveStyle]}
          >
            <Text style={[segmentTextStyle, selected && segmentTextActiveStyle]}>
              {option.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const headerButtonStyle = {
  width: 34,
  height: 34,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
};
const threadContentStyle = { padding: 16, gap: 14 };
const threadBriefStyle = { gap: 10 };
const threadBriefHeaderStyle = {
  flexDirection: 'row' as const,
  alignItems: 'flex-start' as const,
  gap: 12,
};
const messageListStyle = { gap: 12 };
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
const controlRowStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 8,
  flexWrap: 'wrap' as const,
};
const segmentedStyle = {
  flexDirection: 'row' as const,
  backgroundColor: companionColors.surfaceMuted,
  borderColor: companionColors.borderSubtle,
  borderWidth: 1,
  borderRadius: 8,
  padding: 2,
};
const segmentStyle = {
  paddingHorizontal: 10,
  paddingVertical: 7,
  borderRadius: 6,
};
const segmentActiveStyle = { backgroundColor: companionColors.dark };
const segmentTextStyle = {
  color: companionColors.subtle,
  fontSize: 12,
  fontWeight: '900' as const,
};
const segmentTextActiveStyle = { color: companionColors.onDark };
const reasoningRowStyle = {
  flexDirection: 'row' as const,
  gap: 5,
  flex: 1,
  justifyContent: 'flex-end' as const,
};
const reasoningChipStyle = {
  borderColor: companionColors.borderSubtle,
  borderWidth: 1,
  borderRadius: 999,
  paddingHorizontal: 8,
  paddingVertical: 6,
  backgroundColor: companionColors.surface,
};
const reasoningChipActiveStyle = {
  backgroundColor: companionColors.blueSoft,
  borderColor: companionColors.blueBorder,
};
const reasoningChipTextStyle = {
  color: companionColors.subtle,
  fontSize: 11,
  fontWeight: '900' as const,
};
const reasoningChipTextActiveStyle = { color: companionColors.blue };
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
  maxHeight: 132,
  textAlignVertical: 'top' as const,
};
const composerActionRowStyle = {
  flexDirection: 'row' as const,
  gap: 8,
};
const composerToolButtonStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  gap: 6,
  flex: 1,
  minHeight: 38,
  borderWidth: 1,
  borderRadius: 8,
  borderColor: companionColors.borderSubtle,
  backgroundColor: companionColors.surfaceMuted,
};
const composerToolButtonTextStyle = {
  color: companionColors.ink,
  fontSize: 13,
  fontWeight: '900' as const,
};
const composerHintStyle = {
  flex: 1,
  alignSelf: 'center' as const,
  color: companionColors.subtle,
  fontSize: 12,
  fontWeight: '700' as const,
};
const disabledToolButtonStyle = { opacity: 0.5 };
const sendButtonStyle = { minHeight: 44 };

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { router, Stack, type RelativePathString } from 'expo-router';
import { useEffect, useMemo, useState, type ComponentProps } from 'react';
import { RefreshControl, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import {
  ActionButton,
  AttentionPanel,
  EmptyState,
  Panel,
  SignalGrid,
  SignalTile,
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
  ChatAttachmentInput,
  ChatCollaborationMode,
  ChatFileMentionSearchResult,
  CodexRegisteredSkill,
  MobileChatThreadSummary,
  ReasoningEffort,
} from '../../../../src/shared/types';

type IconName = ComponentProps<typeof MaterialIcons>['name'];

const REASONING_LEVELS: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export default function ChatsInboxScreen() {
  const { threads, overview, loading, refresh, startWorkflow, searchFiles, searchSkills } =
    useCompanion();
  const [query, setQuery] = useState('');
  const [launchDraft, setLaunchDraft] = useState('');
  const [launching, setLaunching] = useState(false);
  const [mode, setMode] = useState<ChatCollaborationMode>('default');
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('medium');
  const [attachments, setAttachments] = useState<ChatAttachmentInput[]>([]);
  const [pickingAttachment, setPickingAttachment] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [fileSuggestions, setFileSuggestions] = useState<ChatFileMentionSearchResult[]>([]);
  const [skillSuggestions, setSkillSuggestions] = useState<CodexRegisteredSkill[]>([]);

  const activeWorkspace = overview?.activeWorkspace;
  const activeRepoIds = useMemo(
    () => activeWorkspace?.repos.map((repo) => repo.id) ?? [],
    [activeWorkspace],
  );
  const liveThreadCount = threads.filter((thread) => thread.activeSessionId).length;
  const pendingApprovalCount = threads.reduce(
    (total, thread) => total + thread.pendingApprovalCount,
    0,
  );
  const sortedThreads = useMemo(
    () => [...threads].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    [threads],
  );
  const filteredThreads = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return sortedThreads;
    return sortedThreads.filter((thread) =>
      [
        thread.title,
        thread.preview,
        thread.personaId,
        thread.activeSessionStatus,
        thread.workspaceId,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(normalized),
    );
  }, [query, sortedThreads]);
  const leadThread =
    sortedThreads.find((thread) => thread.pendingApprovalCount > 0) ??
    sortedThreads.find((thread) => thread.activeSessionId) ??
    sortedThreads[0];
  const activeTrigger = useMemo(() => activeComposerTrigger(launchDraft), [launchDraft]);

  useEffect(() => {
    let cancelled = false;
    const loadSuggestions = async () => {
      if (!activeTrigger) {
        setFileSuggestions([]);
        setSkillSuggestions([]);
        return;
      }
      if (activeTrigger.kind === 'file') {
        setSkillSuggestions([]);
        if (activeRepoIds.length === 0) {
          setFileSuggestions([]);
          return;
        }
        const results = await searchFiles({
          repoIds: activeRepoIds,
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
  }, [activeRepoIds, activeTrigger, searchFiles, searchSkills]);

  const launchFromPhone = async () => {
    const trimmedDraft = launchDraft.trim();
    if (!trimmedDraft && attachments.length === 0) return;
    const message = trimmedDraft || attachmentOnlyMessage(attachments);
    setLaunching(true);
    setAttachmentError(null);
    try {
      const result = await startWorkflow({
        message,
        title: titleFromPrompt(message),
        workspaceId: activeWorkspace?.id,
        repoIds: activeRepoIds,
        attachments,
        collaborationMode: mode,
        reasoningEffort,
      });
      setLaunchDraft('');
      setAttachments([]);
      setFileSuggestions([]);
      setSkillSuggestions([]);
      if (result?.thread.id) {
        router.push(threadHref(result.thread.id));
      }
    } finally {
      setLaunching(false);
    }
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
    setLaunchDraft((current) => replaceActiveTrigger(current, `@${file.relativePath} `));
    setFileSuggestions([]);
  };

  const selectSkillSuggestion = (skill: CodexRegisteredSkill) => {
    setLaunchDraft((current) => replaceActiveTrigger(current, `$${skill.name} `));
    setSkillSuggestions([]);
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

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Chats',
          headerSearchBarOptions: {
            placeholder: 'Search threads',
            onChangeText: (event) => setQuery(event.nativeEvent.text),
            onCancelButtonPress: () => setQuery(''),
          },
        }}
      />
      <ScrollView
        style={screenStyle}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} />}
        contentContainerStyle={scrollContentStyle}
      >
        <AttentionPanel
          label={pendingApprovalCount > 0 ? 'NEEDS YOU' : liveThreadCount > 0 ? 'LIVE' : 'READY'}
          title={leadThread ? leadThread.title : 'Start or resume a thread'}
          detail={
            leadThread
              ? threadSummary(leadThread)
              : 'Send a prompt to the Mac, then use this phone to steer the run.'
          }
          tone={pendingApprovalCount > 0 ? 'red' : liveThreadCount > 0 ? 'blue' : 'cyan'}
          right={
            leadThread ? (
              <ActionButton
                label="Open"
                variant="secondary"
                onPress={() => router.push(threadHref(leadThread.id))}
                style={{ paddingVertical: 8 }}
              />
            ) : undefined
          }
        />

        <SignalGrid>
          <SignalTile label="Threads" value={threads.length} detail="total" tone="neutral" />
          <SignalTile
            label="Live"
            value={liveThreadCount}
            detail="running"
            tone={liveThreadCount > 0 ? 'blue' : 'neutral'}
          />
          <SignalTile
            label="Blocked"
            value={pendingApprovalCount}
            detail="approvals"
            tone={pendingApprovalCount > 0 ? 'red' : 'green'}
          />
        </SignalGrid>

        <Panel tone="dark" style={composerPanelStyle}>
          <View style={composerHeaderStyle}>
            <View style={composerIconStyle}>
              <MaterialIcons name="bolt" size={18} color={companionColors.accent} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={darkEyebrowStyle}>NEW THREAD</Text>
              <Text style={darkTitleStyle}>Prompt the active workspace</Text>
            </View>
          </View>
          <TextInput
            value={launchDraft}
            onChangeText={setLaunchDraft}
            placeholder="Ask for a change, review, investigation, or handoff. Use @files or $skills..."
            placeholderTextColor={companionColors.darkMuted}
            multiline
            style={darkInputStyle}
          />
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
                    color={companionColors.accent}
                  />
                  <Text numberOfLines={1} style={attachmentChipTextStyle}>
                    {attachment.name}
                  </Text>
                  <MaterialIcons name="close" size={13} color={companionColors.darkMuted} />
                </TouchableOpacity>
              ))}
            </View>
          )}
          {attachmentError && (
            <Text selectable style={[subtleStyle, { color: companionColors.redDetail }]}>
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
                  <MaterialIcons name="description" size={16} color={companionColors.blueDetail} />
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
                  <MaterialIcons
                    name="auto-awesome"
                    size={16}
                    color={companionColors.purpleDetail}
                  />
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
          <View style={composerControlRowStyle}>
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
          <View style={composerActionRowStyle}>
            <TouchableOpacity
              activeOpacity={0.72}
              onPress={() => void pickFiles()}
              disabled={pickingAttachment || attachments.length >= MAX_ATTACHMENT_COUNT}
              style={[composerToolButtonStyle, pickingAttachment && disabledToolButtonStyle]}
            >
              <MaterialIcons name="attach-file" size={18} color={companionColors.onDark} />
              <Text style={composerToolButtonTextStyle}>File</Text>
            </TouchableOpacity>
            <TouchableOpacity
              activeOpacity={0.72}
              onPress={() => void pickPhotos()}
              disabled={pickingAttachment || attachments.length >= MAX_ATTACHMENT_COUNT}
              style={[composerToolButtonStyle, pickingAttachment && disabledToolButtonStyle]}
            >
              <MaterialIcons name="image" size={18} color={companionColors.onDark} />
              <Text style={composerToolButtonTextStyle}>Photo</Text>
            </TouchableOpacity>
            <Text numberOfLines={1} style={composerHintStyle}>
              {activeWorkspace ? activeWorkspace.name : 'Pair a Mac for workspace context'}
            </Text>
          </View>
          <ActionButton
            label={launching ? 'Launching...' : 'Launch'}
            onPress={() => void launchFromPhone()}
            disabled={(!launchDraft.trim() && attachments.length === 0) || launching}
            style={{ backgroundColor: companionColors.accent, borderColor: companionColors.accent }}
            textStyle={{ color: companionColors.dark }}
          />
        </Panel>

        <View style={threadListHeaderStyle}>
          <Text style={titleStyle}>Threads</Text>
          {query.trim() ? (
            <Text style={subtleStyle}>
              {filteredThreads.length} of {threads.length}
            </Text>
          ) : (
            <Text style={subtleStyle}>{threads.length} available</Text>
          )}
        </View>

        {filteredThreads.length === 0 ? (
          <EmptyState
            title={threads.length === 0 ? 'No threads' : 'No matching threads'}
            body={
              threads.length === 0
                ? 'Launch a prompt above or start a desktop chat.'
                : 'Clear search or try a repo, persona, or status.'
            }
          />
        ) : (
          <View style={threadListStyle}>
            {filteredThreads.map((thread) => (
              <ThreadRow key={thread.id} thread={thread} />
            ))}
          </View>
        )}
      </ScrollView>
    </>
  );
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

function ThreadRow({ thread }: { thread: MobileChatThreadSummary }) {
  const status = threadStatus(thread);
  return (
    <TouchableOpacity
      activeOpacity={0.78}
      onPress={() => router.push(threadHref(thread.id))}
      style={threadRowStyle}
    >
      <View style={threadRowTopStyle}>
        <View style={{ flex: 1, gap: 5 }}>
          <Text numberOfLines={1} style={titleStyle}>
            {thread.title}
          </Text>
          <Text numberOfLines={2} style={bodyStyle}>
            {thread.preview || `${thread.personaId} / ${thread.messageCount} messages`}
          </Text>
        </View>
        <MaterialIcons name="chevron-right" size={22} color={companionColors.faint} />
      </View>
      <View style={threadMetaStyle}>
        <StatusPill label={status.label} color={status.color} background={status.background} />
        <Text style={threadMetaTextStyle}>{compactCount(thread.messageCount, 'message')}</Text>
        <Text style={threadMetaTextStyle}>{relativeTime(thread.updatedAt)}</Text>
      </View>
    </TouchableOpacity>
  );
}

function threadStatus(thread: MobileChatThreadSummary) {
  if (thread.pendingApprovalCount > 0) {
    return {
      label: `${thread.pendingApprovalCount} approval${thread.pendingApprovalCount === 1 ? '' : 's'}`,
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

function threadSummary(thread: MobileChatThreadSummary): string {
  const status = thread.pendingApprovalCount
    ? `${thread.pendingApprovalCount} approval${thread.pendingApprovalCount === 1 ? '' : 's'} waiting`
    : thread.activeSessionId
      ? `${thread.activeSessionStatus ?? 'live'} session`
      : 'ready for a follow-up';
  return `${status} / ${compactCount(thread.messageCount, 'message')} / ${relativeTime(thread.updatedAt)}`;
}

function compactCount(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? '' : 's'}`;
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

function titleFromPrompt(message: string): string {
  const firstLine =
    message
      .split('\n')
      .find((line) => line.trim())
      ?.trim() ?? 'Remote prompt';
  return firstLine.length > 64 ? `${firstLine.slice(0, 61)}...` : firstLine;
}

function threadHref(threadId: string): RelativePathString {
  return `/(tabs)/chats/${encodeURIComponent(threadId)}` as RelativePathString;
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

const composerPanelStyle = { gap: 14 };
const composerHeaderStyle = {
  flexDirection: 'row' as const,
  gap: 12,
  alignItems: 'flex-start' as const,
};
const composerIconStyle = {
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  width: 38,
  height: 38,
  borderRadius: 10,
  backgroundColor: companionColors.darkIconSurface,
};
const darkEyebrowStyle = {
  color: companionColors.darkMuted,
  fontSize: 12,
  fontWeight: '800' as const,
};
const darkTitleStyle = { color: companionColors.onDark, fontSize: 18, fontWeight: '900' as const };
const darkInputStyle = {
  ...inputStyle,
  minHeight: 92,
  backgroundColor: companionColors.darkRaised,
  borderColor: companionColors.darkBorder,
  color: companionColors.onDark,
  textAlignVertical: 'top' as const,
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
  borderColor: companionColors.darkBorder,
  borderWidth: 1,
  borderRadius: 999,
  paddingHorizontal: 9,
  paddingVertical: 6,
  backgroundColor: companionColors.darkControlActive,
};
const attachmentChipTextStyle = {
  flexShrink: 1,
  color: companionColors.onDark,
  fontSize: 12,
  fontWeight: '800' as const,
};
const suggestionPanelStyle = {
  borderWidth: 1,
  borderColor: companionColors.darkBorder,
  borderRadius: 8,
  backgroundColor: companionColors.darkRaised,
  overflow: 'hidden' as const,
};
const suggestionRowStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 9,
  paddingHorizontal: 10,
  paddingVertical: 9,
  borderBottomColor: companionColors.darkBorder,
  borderBottomWidth: 1,
};
const suggestionTitleStyle = {
  color: companionColors.onDark,
  fontSize: 13,
  fontWeight: '900' as const,
};
const suggestionDetailStyle = {
  color: companionColors.darkMuted,
  fontSize: 12,
};
const suggestionHintStyle = {
  color: companionColors.darkMuted,
  fontSize: 11,
  fontWeight: '900' as const,
};
const composerControlRowStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 8,
  flexWrap: 'wrap' as const,
};
const segmentedStyle = {
  flexDirection: 'row' as const,
  backgroundColor: companionColors.darkRaised,
  borderColor: companionColors.darkBorder,
  borderWidth: 1,
  borderRadius: 8,
  padding: 2,
};
const segmentStyle = {
  paddingHorizontal: 10,
  paddingVertical: 7,
  borderRadius: 6,
};
const segmentActiveStyle = { backgroundColor: companionColors.accent };
const segmentTextStyle = {
  color: companionColors.darkMuted,
  fontSize: 12,
  fontWeight: '900' as const,
};
const segmentTextActiveStyle = { color: companionColors.dark };
const reasoningRowStyle = {
  flexDirection: 'row' as const,
  gap: 5,
  flex: 1,
  justifyContent: 'flex-end' as const,
};
const reasoningChipStyle = {
  borderColor: companionColors.darkBorder,
  borderWidth: 1,
  borderRadius: 999,
  paddingHorizontal: 8,
  paddingVertical: 6,
  backgroundColor: companionColors.darkRaised,
};
const reasoningChipActiveStyle = {
  backgroundColor: companionColors.darkControlActive,
  borderColor: companionColors.accent,
};
const reasoningChipTextStyle = {
  color: companionColors.darkMuted,
  fontSize: 11,
  fontWeight: '900' as const,
};
const reasoningChipTextActiveStyle = { color: companionColors.accent };
const composerActionRowStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 8,
};
const composerToolButtonStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  gap: 6,
  minHeight: 38,
  minWidth: 82,
  borderWidth: 1,
  borderRadius: 8,
  borderColor: companionColors.darkBorder,
  backgroundColor: companionColors.darkControl,
};
const composerToolButtonTextStyle = {
  color: companionColors.onDark,
  fontSize: 13,
  fontWeight: '900' as const,
};
const composerHintStyle = {
  flex: 1,
  alignSelf: 'center' as const,
  color: companionColors.darkMuted,
  fontSize: 12,
  fontWeight: '700' as const,
};
const disabledToolButtonStyle = { opacity: 0.5 };
const threadListHeaderStyle = {
  flexDirection: 'row' as const,
  alignItems: 'baseline' as const,
  justifyContent: 'space-between' as const,
};
const threadListStyle = { gap: 10 };
const threadRowStyle = {
  backgroundColor: companionColors.surface,
  borderColor: companionColors.borderSubtle,
  borderWidth: 1,
  borderRadius: 8,
  padding: 14,
  gap: 12,
};
const threadRowTopStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 12,
};
const threadMetaStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  flexWrap: 'wrap' as const,
  gap: 8,
};
const threadMetaTextStyle = {
  color: companionColors.subtle,
  fontSize: 12,
  fontWeight: '700' as const,
};

import { useState, useRef, useCallback, useEffect } from 'react';
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  Image as ImageIcon,
  ListChecks,
  Loader2,
  Paperclip,
  Send,
  SlidersHorizontal,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import type {
  ChatAttachment,
  ChatAttachmentInput,
  ChatFileMentionSearchResult,
  CodexRegisteredSkill,
  ReasoningEffort,
} from '../../../shared/types';
import { VoiceInputButton } from './VoiceInputButton';
import { slugForDomId } from '../../utils/dom-id';
import { getNextListboxIndex } from '../../utils/list-navigation';
import { EXECUTION_STRATEGIES, type ExecutionStrategy } from '../../utils/execution-strategy';

const MAX_ATTACHMENT_COUNT = 10;
const MAX_RENDERER_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const FILE_MENTION_SEARCH_LIMIT = 24;
const FILE_MENTION_MENU_ID = 'chat-file-mention-menu';
const SLASH_COMMAND_MENU_ID = 'chat-slash-command-menu';
const SKILL_MENTION_MENU_ID = 'chat-skill-mention-menu';

interface ActiveFileMention {
  start: number;
  end: number;
  query: string;
}

interface ActiveTextTrigger {
  start: number;
  end: number;
  query: string;
}

export interface ChatQuickPrompt {
  id: string;
  label: string;
  prompt: string;
}

export interface ChatSlashCommand {
  id: string;
  command: string;
  label: string;
  description: string;
  insertText?: string;
}

interface ChatComposerKeyEvent {
  key: string;
  shiftKey: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
}

interface ChatInputProps {
  onSend: (message: string, attachments?: ChatAttachment[]) => void;
  onStop?: () => void;
  disabled: boolean;
  busy?: boolean;
  personaColour: string;
  reasoningLevel?: ReasoningEffort;
  reasoningOptions?: ReasoningEffort[];
  onReasoningChange?: (level: ReasoningEffort) => void;
  executionStrategy?: ExecutionStrategy;
  onExecutionStrategyChange?: (strategy: ExecutionStrategy) => void;
  prefill?: { id: string; text: string } | null;
  draftKey?: string;
  mentionRepoIds?: string[];
  quickPrompts?: ChatQuickPrompt[];
  slashCommands?: ChatSlashCommand[];
  focusRequest?: number;
}

export function ChatInput({
  onSend,
  onStop,
  disabled,
  busy,
  personaColour,
  reasoningLevel = 'medium',
  reasoningOptions,
  onReasoningChange,
  executionStrategy = 'auto',
  onExecutionStrategyChange,
  prefill,
  draftKey,
  mentionRepoIds = [],
  quickPrompts = [],
  slashCommands = [],
  focusRequest = 0,
}: ChatInputProps) {
  const [value, setValue] = useState(() => loadDraft(draftKey));
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentPreviews, setAttachmentPreviews] = useState<Record<string, string>>({});
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [preparingAttachments, setPreparingAttachments] = useState(false);
  const [fileMention, setFileMention] = useState<ActiveFileMention | null>(null);
  const [fileMentionResults, setFileMentionResults] = useState<ChatFileMentionSearchResult[]>([]);
  const [fileMentionLoading, setFileMentionLoading] = useState(false);
  const [fileMentionError, setFileMentionError] = useState<string | null>(null);
  const [selectedFileMentionIndex, setSelectedFileMentionIndex] = useState(0);
  const [slashCommand, setSlashCommand] = useState<ActiveTextTrigger | null>(null);
  const [selectedSlashCommandIndex, setSelectedSlashCommandIndex] = useState(0);
  const [skillMention, setSkillMention] = useState<ActiveTextTrigger | null>(null);
  const [registeredSkills, setRegisteredSkills] = useState<CodexRegisteredSkill[]>([]);
  const [skillsLoaded, setSkillsLoaded] = useState(false);
  const [skillMentionLoading, setSkillMentionLoading] = useState(false);
  const [skillMentionError, setSkillMentionError] = useState<string | null>(null);
  const [selectedSkillMentionIndex, setSelectedSkillMentionIndex] = useState(0);
  const [dragDepth, setDragDepth] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const skipNextDraftSaveRef = useRef(false);
  const mentionRepoKey = mentionRepoIds.join('\0');
  const draggingFiles = dragDepth > 0;

  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if ((!trimmed && attachments.length === 0) || disabled || preparingAttachments) return;
    onSend(trimmed, attachments);
    setValue('');
    setAttachments([]);
    setAttachmentPreviews({});
    setAttachmentError(null);
    setFileMention(null);
    setFileMentionResults([]);
    setFileMentionError(null);
    setSlashCommand(null);
    setSkillMention(null);
    setSkillMentionError(null);
    clearDraft(draftKey);
    window.requestAnimationFrame(resizeTextarea);
  }, [value, attachments, disabled, preparingAttachments, onSend, draftKey, resizeTextarea]);

  const refreshComposerTriggers = useCallback(
    (nextValue: string, selectionStart: number | null) => {
      const nextFileMention = findActiveFileMention(nextValue, selectionStart);
      const nextSlashCommand = nextFileMention
        ? null
        : findActiveSlashCommand(nextValue, selectionStart);
      const nextSkillMention =
        nextFileMention || nextSlashCommand
          ? null
          : findActiveSkillMention(nextValue, selectionStart);

      setFileMention(nextFileMention);
      setSlashCommand(nextSlashCommand);
      setSkillMention(nextSkillMention);
    },
    [],
  );

  const handleTextChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      const nextValue = event.target.value;
      setValue(nextValue);
      refreshComposerTriggers(nextValue, event.target.selectionStart);
    },
    [refreshComposerTriggers],
  );

  const handleTextareaSelection = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    refreshComposerTriggers(value, textarea.selectionStart);
  }, [refreshComposerTriggers, value]);

  const addFiles = useCallback(
    async (files: File[]) => {
      if (disabled || files.length === 0) return;

      const remainingSlots = MAX_ATTACHMENT_COUNT - attachments.length;
      if (remainingSlots <= 0) {
        setAttachmentError(`Attach up to ${MAX_ATTACHMENT_COUNT} files at a time.`);
        return;
      }

      const selectedFiles = files.slice(0, remainingSlots);
      setPreparingAttachments(true);
      setAttachmentError(files.length > remainingSlots ? 'Some files were skipped.' : null);

      try {
        const preparedInputs = await Promise.all(selectedFiles.map(fileToAttachmentInput));
        const prepared = await window.anvil.chat.prepareAttachments(
          preparedInputs.map((item) => item.input),
        );
        const previews = preparedInputs.reduce<Record<string, string>>((acc, item) => {
          if (item.previewDataUrl) acc[item.input.id!] = item.previewDataUrl;
          return acc;
        }, {});

        setAttachments((prev) => mergeAttachments(prev, prepared));
        setAttachmentPreviews((prev) => ({ ...prev, ...previews }));
      } catch (err) {
        setAttachmentError(err instanceof Error ? err.message : 'Failed to attach file.');
      } finally {
        setPreparingAttachments(false);
      }
    },
    [attachments.length, disabled],
  );

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = extractClipboardFiles(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      void addFiles(files);
    },
    [addFiles],
  );

  const handleSelectAttachments = useCallback(async () => {
    if (disabled) return;
    const remainingSlots = MAX_ATTACHMENT_COUNT - attachments.length;
    if (remainingSlots <= 0) {
      setAttachmentError(`Attach up to ${MAX_ATTACHMENT_COUNT} files at a time.`);
      return;
    }

    setPreparingAttachments(true);
    setAttachmentError(null);
    try {
      const selected = await window.anvil.chat.selectAttachments();
      setAttachments((prev) => mergeAttachments(prev, selected.slice(0, remainingSlots)));
      if (selected.length > remainingSlots) {
        setAttachmentError('Some files were skipped.');
      }
    } catch (err) {
      setAttachmentError(err instanceof Error ? err.message : 'Failed to attach file.');
    } finally {
      setPreparingAttachments(false);
    }
  }, [attachments.length, disabled]);

  const removeAttachment = useCallback((attachmentId: string) => {
    setAttachments((prev) => prev.filter((attachment) => attachment.id !== attachmentId));
    setAttachmentPreviews((prev) => {
      const next = { ...prev };
      delete next[attachmentId];
      return next;
    });
  }, []);

  const handleSelectFileMention = useCallback(
    async (result: ChatFileMentionSearchResult) => {
      if (disabled || preparingAttachments || !fileMention) return;
      if (attachments.length >= MAX_ATTACHMENT_COUNT) {
        setAttachmentError(`Attach up to ${MAX_ATTACHMENT_COUNT} files at a time.`);
        return;
      }

      setPreparingAttachments(true);
      setAttachmentError(null);
      try {
        const prepared = await window.anvil.chat.prepareAttachments([
          { name: result.name, path: result.path },
        ]);
        setAttachments((prev) => mergeAttachments(prev, prepared));

        const insert = `@${buildFileMentionLabel(result, mentionRepoIds.length > 1)} `;
        const nextValue = `${value.slice(0, fileMention.start)}${insert}${value
          .slice(fileMention.end)
          .replace(/^\s+/, '')}`;
        const nextCaretPosition = fileMention.start + insert.length;

        setValue(nextValue);
        setFileMention(null);
        setFileMentionResults([]);
        setFileMentionError(null);
        setSlashCommand(null);
        setSkillMention(null);

        window.requestAnimationFrame(() => {
          const textarea = textareaRef.current;
          if (!textarea) return;
          textarea.focus();
          textarea.setSelectionRange(nextCaretPosition, nextCaretPosition);
          resizeTextarea();
        });
      } catch (err) {
        setAttachmentError(err instanceof Error ? err.message : 'Failed to mention file.');
      } finally {
        setPreparingAttachments(false);
      }
    },
    [
      attachments.length,
      disabled,
      fileMention,
      mentionRepoIds.length,
      preparingAttachments,
      resizeTextarea,
      value,
    ],
  );

  const handleSelectSlashCommand = useCallback(
    (command: ChatSlashCommand) => {
      if (disabled || !slashCommand) return;

      const insert = command.insertText ?? `${command.command} `;
      const nextValue = `${value.slice(0, slashCommand.start)}${insert}${value
        .slice(slashCommand.end)
        .replace(/^\s+/, '')}`;
      const nextCaretPosition = slashCommand.start + insert.length;

      setValue(nextValue);
      setSlashCommand(null);

      window.requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(nextCaretPosition, nextCaretPosition);
        resizeTextarea();
      });
    },
    [disabled, resizeTextarea, slashCommand, value],
  );

  const handleSelectSkillMention = useCallback(
    (skill: CodexRegisteredSkill) => {
      if (disabled || !skillMention) return;

      const insert = `$${skill.name} `;
      const nextValue = `${value.slice(0, skillMention.start)}${insert}${value
        .slice(skillMention.end)
        .replace(/^\s+/, '')}`;
      const nextCaretPosition = skillMention.start + insert.length;

      setValue(nextValue);
      setSkillMention(null);
      setSkillMentionError(null);

      window.requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(nextCaretPosition, nextCaretPosition);
        resizeTextarea();
      });
    },
    [disabled, resizeTextarea, skillMention, value],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (fileMention && fileMentionResults.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedFileMentionIndex(
          (prev) => getNextListboxIndex(e.key, prev, fileMentionResults.length) ?? prev,
        );
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedFileMentionIndex(
          (prev) => getNextListboxIndex(e.key, prev, fileMentionResults.length) ?? prev,
        );
        return;
      }
      if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        setSelectedFileMentionIndex(
          (prev) => getNextListboxIndex(e.key, prev, fileMentionResults.length) ?? prev,
        );
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        void handleSelectFileMention(fileMentionResults[selectedFileMentionIndex]);
        return;
      }
    }

    const slashCommandResults = getSlashCommandResults(slashCommands, slashCommand?.query ?? '');

    if (slashCommand && slashCommandResults.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        setSelectedSlashCommandIndex(
          (prev) => getNextListboxIndex(e.key, prev, slashCommandResults.length) ?? prev,
        );
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        handleSelectSlashCommand(slashCommandResults[selectedSlashCommandIndex]);
        return;
      }
    }

    const skillMentionResults = getSkillMentionResults(registeredSkills, skillMention?.query ?? '');

    if (skillMention && skillMentionResults.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        setSelectedSkillMentionIndex(
          (prev) => getNextListboxIndex(e.key, prev, skillMentionResults.length) ?? prev,
        );
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        handleSelectSkillMention(skillMentionResults[selectedSkillMentionIndex]);
        return;
      }
    }

    if ((fileMention || slashCommand || skillMention) && e.key === 'Escape') {
      e.preventDefault();
      setFileMention(null);
      setFileMentionResults([]);
      setFileMentionError(null);
      setSlashCommand(null);
      setSkillMention(null);
      setSkillMentionError(null);
      return;
    }

    if (shouldSendChatMessageFromKey(e)) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = () => {
    resizeTextarea();
  };

  const handleVoiceTranscript = useCallback(
    (text: string) => {
      if (text.trim()) {
        setValue((prev) => (prev ? `${prev} ${text}` : text));
        setTimeout(() => {
          if (textareaRef.current) {
            textareaRef.current.focus();
            resizeTextarea();
          }
        }, 0);
      }
    },
    [resizeTextarea],
  );

  const handleQuickPrompt = useCallback(
    (prompt: string) => {
      setValue(prompt);
      setFileMention(null);
      setFileMentionResults([]);
      setSlashCommand(null);
      setSkillMention(null);
      window.requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(prompt.length, prompt.length);
        resizeTextarea();
      });
    },
    [resizeTextarea],
  );

  const handleDragEnter = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (disabled || !event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      setDragDepth((prev) => prev + 1);
    },
    [disabled],
  );

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (disabled || !event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    [disabled],
  );

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    setDragDepth((prev) => Math.max(0, prev - 1));
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (disabled || !event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      setDragDepth(0);
      void addFiles(Array.from(event.dataTransfer.files));
    },
    [addFiles, disabled],
  );

  useEffect(() => {
    if (!disabled && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [disabled]);

  useEffect(() => {
    if (disabled || focusRequest === 0) return;
    textareaRef.current?.focus();
  }, [disabled, focusRequest]);

  useEffect(() => {
    skipNextDraftSaveRef.current = true;
    setValue(loadDraft(draftKey));
    setFileMention(null);
    setFileMentionResults([]);
    setSlashCommand(null);
    setSkillMention(null);
  }, [draftKey]);

  useEffect(() => {
    if (!prefill) return;

    setValue((prev) => (prev.trim() ? `${prev}\n\n${prefill.text}` : prefill.text));

    setTimeout(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      resizeTextarea();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 0);
  }, [prefill, resizeTextarea]);

  useEffect(() => {
    if (disabled || !fileMention || mentionRepoIds.length === 0) {
      setFileMentionResults([]);
      setFileMentionLoading(false);
      setFileMentionError(null);
      return;
    }

    let cancelled = false;
    setFileMentionLoading(true);
    setFileMentionError(null);

    const timer = window.setTimeout(() => {
      window.anvil.chat
        .searchFileMentions({
          repoIds: mentionRepoIds,
          query: fileMention.query,
          limit: FILE_MENTION_SEARCH_LIMIT,
        })
        .then((results) => {
          if (cancelled) return;
          setFileMentionResults(results);
          setSelectedFileMentionIndex(0);
        })
        .catch((err) => {
          if (cancelled) return;
          setFileMentionResults([]);
          setFileMentionError(err instanceof Error ? err.message : 'Failed to search files.');
        })
        .finally(() => {
          if (!cancelled) setFileMentionLoading(false);
        });
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [disabled, fileMention, mentionRepoIds, mentionRepoKey]);

  useEffect(() => {
    setSelectedSlashCommandIndex(0);
  }, [slashCommand?.query]);

  useEffect(() => {
    setSelectedSkillMentionIndex(0);
  }, [skillMention?.query]);

  useEffect(() => {
    if (disabled || !skillMention || skillsLoaded) {
      if (!skillMention) setSkillMentionError(null);
      return;
    }

    let cancelled = false;
    setSkillMentionLoading(true);
    setSkillMentionError(null);

    window.anvil.codexRegistry
      .snapshot()
      .then((snapshot) => {
        if (cancelled) return;
        setRegisteredSkills(snapshot.skills);
        setSkillsLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setRegisteredSkills([]);
        setSkillMentionError(err instanceof Error ? err.message : 'Failed to load skills.');
      })
      .finally(() => {
        if (!cancelled) setSkillMentionLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [disabled, skillMention, skillsLoaded]);

  useEffect(() => {
    if (skipNextDraftSaveRef.current) {
      skipNextDraftSaveRef.current = false;
      window.requestAnimationFrame(resizeTextarea);
      return;
    }
    saveDraft(draftKey, value);
    window.requestAnimationFrame(resizeTextarea);
  }, [draftKey, resizeTextarea, value]);

  const hasContent = value.trim().length > 0 || attachments.length > 0;
  const showQuickPrompts =
    !busy &&
    !disabled &&
    !hasContent &&
    quickPrompts.length > 0 &&
    !fileMention &&
    !slashCommand &&
    !skillMention;
  const showFileMentionMenu =
    !!fileMention &&
    mentionRepoIds.length > 0 &&
    !disabled &&
    (fileMentionLoading ||
      fileMentionError ||
      fileMentionResults.length > 0 ||
      !!fileMention.query);
  const slashCommandResults = getSlashCommandResults(slashCommands, slashCommand?.query ?? '');
  const showSlashCommandMenu =
    !!slashCommand &&
    !disabled &&
    slashCommands.length > 0 &&
    (slashCommandResults.length > 0 || !!slashCommand.query);
  const skillMentionResults = getSkillMentionResults(registeredSkills, skillMention?.query ?? '');
  const showSkillMentionMenu =
    !!skillMention &&
    !disabled &&
    (skillMentionLoading ||
      skillMentionError ||
      skillMentionResults.length > 0 ||
      !!skillMention.query);
  const selectedFileMentionResult = fileMentionResults[selectedFileMentionIndex];
  const selectedSlashCommandResult = slashCommandResults[selectedSlashCommandIndex];
  const selectedSkillMentionResult = skillMentionResults[selectedSkillMentionIndex];
  const activeMenuId = showFileMentionMenu
    ? FILE_MENTION_MENU_ID
    : showSlashCommandMenu
      ? SLASH_COMMAND_MENU_ID
      : showSkillMentionMenu
        ? SKILL_MENTION_MENU_ID
        : undefined;
  const activeDescendant = showFileMentionMenu
    ? selectedFileMentionResult
      ? buildFileMentionOptionId(selectedFileMentionResult)
      : undefined
    : showSlashCommandMenu
      ? selectedSlashCommandResult
        ? buildSlashCommandOptionId(selectedSlashCommandResult)
        : undefined
      : showSkillMentionMenu && selectedSkillMentionResult
        ? buildSkillMentionOptionId(selectedSkillMentionResult)
        : undefined;

  return (
    <div className="border-t border-border/50 bg-bg-secondary px-3 py-3 lg:px-4">
      <div className="mx-auto w-full max-w-[72ch]">
        <div
          className={`relative rounded-2xl border bg-bg-primary transition-colors duration-200 ${
            disabled && !busy ? 'opacity-60' : ''
          } ${
            draggingFiles
              ? 'border-accent bg-accent/5 shadow-accent/10'
              : hasContent
                ? 'border-accent/30 shadow-accent/5'
                : 'border-border'
          }`}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {draggingFiles && (
            <div className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-xl border border-dashed border-accent bg-bg-primary/80 backdrop-blur-sm">
              <div className="flex items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-4 py-2 text-sm font-medium text-text-primary">
                <Paperclip size={14} className="text-accent" />
                Drop files to attach
              </div>
            </div>
          )}

          {(attachments.length > 0 || attachmentError) && (
            <div className="border-b border-border-subtle px-3 py-2">
              {attachments.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {attachments.map((attachment) => (
                    <ComposerAttachmentChip
                      key={attachment.id}
                      attachment={attachment}
                      previewDataUrl={attachmentPreviews[attachment.id]}
                      onRemove={() => removeAttachment(attachment.id)}
                    />
                  ))}
                </div>
              )}
              {attachmentError && (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-warning">
                  <AlertCircle size={12} />
                  {attachmentError}
                </p>
              )}
            </div>
          )}

          {showQuickPrompts && (
            <div
              className="flex gap-1 overflow-x-auto px-3 pt-2"
              aria-label="Conversation starters"
            >
              {quickPrompts.slice(0, 4).map((quickPrompt) => (
                <button
                  key={quickPrompt.id}
                  type="button"
                  onClick={() => handleQuickPrompt(quickPrompt.prompt)}
                  className="shrink-0 rounded-md px-2 py-1 text-[11px] font-medium text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
                >
                  {quickPrompt.label}
                </button>
              ))}
            </div>
          )}

          {showFileMentionMenu && (
            <FileMentionMenu
              id={FILE_MENTION_MENU_ID}
              results={fileMentionResults}
              selectedIndex={selectedFileMentionIndex}
              loading={fileMentionLoading}
              error={fileMentionError}
              onSelect={(result) => void handleSelectFileMention(result)}
              onHighlight={setSelectedFileMentionIndex}
            />
          )}

          {showSlashCommandMenu && (
            <SlashCommandMenu
              id={SLASH_COMMAND_MENU_ID}
              results={slashCommandResults}
              selectedIndex={selectedSlashCommandIndex}
              onSelect={handleSelectSlashCommand}
              onHighlight={setSelectedSlashCommandIndex}
            />
          )}

          {showSkillMentionMenu && (
            <SkillMentionMenu
              id={SKILL_MENTION_MENU_ID}
              results={skillMentionResults}
              selectedIndex={selectedSkillMentionIndex}
              loading={skillMentionLoading}
              error={skillMentionError}
              onSelect={handleSelectSkillMention}
              onHighlight={setSelectedSkillMentionIndex}
            />
          )}

          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            onClick={handleTextareaSelection}
            onSelect={handleTextareaSelection}
            onInput={handleInput}
            onPaste={handlePaste}
            disabled={disabled}
            aria-label="Chat message"
            aria-describedby="chat-composer-keyboard-hint"
            aria-autocomplete="list"
            aria-expanded={Boolean(activeMenuId)}
            aria-controls={activeMenuId}
            aria-activedescendant={activeDescendant}
            placeholder={
              busy
                ? 'Steer the active turn...'
                : disabled
                  ? 'Chat is not ready yet...'
                  : mentionRepoIds.length > 0
                    ? 'Ask anything, or type /, @, or $...'
                    : 'Ask anything, paste images, or drop files here...'
            }
            rows={1}
            className="chat-input-focus w-full resize-none rounded-2xl bg-transparent px-4 py-3.5 pr-64 text-sm text-text-primary placeholder:text-text-muted focus:outline-none disabled:opacity-50"
            style={{ maxHeight: '300px', minHeight: '48px' }}
          />

          <div className="absolute bottom-2.5 right-2.5 flex items-center gap-1.5">
            {(onExecutionStrategyChange || onReasoningChange) && !busy && (
              <RunSettingsDropdown
                executionStrategy={executionStrategy}
                onExecutionStrategyChange={onExecutionStrategyChange}
                reasoningLevel={reasoningLevel}
                reasoningOptions={reasoningOptions}
                onReasoningChange={onReasoningChange}
              />
            )}

            <VoiceInputButton
              onTranscript={handleVoiceTranscript}
              disabled={disabled}
              colour={personaColour}
            />

            <button
              onClick={() => void handleSelectAttachments()}
              disabled={disabled || preparingAttachments}
              className="flex h-9 w-9 items-center justify-center rounded-xl text-text-tertiary transition-colors duration-200 hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-30"
              title="Attach files"
              aria-label="Attach files"
            >
              {preparingAttachments ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <Paperclip size={15} />
              )}
            </button>

            {busy ? (
              <button
                onClick={onStop}
                className="flex h-9 w-9 items-center justify-center rounded-xl bg-error transition-colors duration-200 hover:bg-error/80"
                title="Stop generation"
                aria-label="Stop generation"
              >
                <Square size={14} className="text-white" fill="currentColor" />
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={disabled || !hasContent || preparingAttachments}
                className="flex h-9 w-9 items-center justify-center rounded-xl transition-colors duration-200 disabled:opacity-30"
                style={{
                  backgroundColor: hasContent ? personaColour : `${personaColour}40`,
                }}
                aria-label="Send message"
              >
                <Send size={16} className="text-white" />
              </button>
            )}
          </div>
        </div>

        <p id="chat-composer-keyboard-hint" className="sr-only">
          Enter sends. Shift plus Enter adds a line.
          {mentionRepoIds.length > 0
            ? ' Type slash for commands, at for files, or dollar for skills.'
            : ' Type slash for commands or dollar for skills.'}
        </p>
      </div>
    </div>
  );
}

function loadDraft(draftKey: string | undefined): string {
  if (!draftKey) return '';
  try {
    return window.localStorage.getItem(draftKey) ?? '';
  } catch {
    return '';
  }
}

function saveDraft(draftKey: string | undefined, value: string): void {
  if (!draftKey) return;
  try {
    if (value.trim()) {
      window.localStorage.setItem(draftKey, value);
    } else {
      window.localStorage.removeItem(draftKey);
    }
  } catch {
    // Storage can be unavailable in restricted renderer contexts.
  }
}

function clearDraft(draftKey: string | undefined): void {
  if (!draftKey) return;
  try {
    window.localStorage.removeItem(draftKey);
  } catch {
    // Storage can be unavailable in restricted renderer contexts.
  }
}

function ComposerAttachmentChip({
  attachment,
  previewDataUrl,
  onRemove,
}: {
  attachment: ChatAttachment;
  previewDataUrl?: string;
  onRemove: () => void;
}) {
  return (
    <div className="flex max-w-full items-center gap-2 rounded-lg border border-border-subtle bg-bg-tertiary/60 py-1 pl-1 pr-1.5 shadow-sm">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-bg-secondary">
        {previewDataUrl ? (
          <img src={previewDataUrl} alt="" className="h-full w-full object-cover" />
        ) : attachment.kind === 'image' ? (
          <ImageIcon size={14} className="text-info" />
        ) : (
          <FileIcon size={14} className="text-text-tertiary" />
        )}
      </div>
      <div className="min-w-0">
        <p className="max-w-48 truncate text-xs font-medium text-text-primary">{attachment.name}</p>
        <p className="text-[11px] text-text-tertiary">{formatAttachmentBytes(attachment.size)}</p>
      </div>
      <button
        onClick={onRemove}
        className="ml-0.5 rounded-md p-1 text-text-tertiary transition-colors hover:bg-bg-secondary hover:text-text-primary"
        title="Remove attachment"
        aria-label={`Remove ${attachment.name}`}
      >
        <X size={12} />
      </button>
    </div>
  );
}

function FileMentionMenu({
  id,
  results,
  selectedIndex,
  loading,
  error,
  onSelect,
  onHighlight,
}: {
  id: string;
  results: ChatFileMentionSearchResult[];
  selectedIndex: number;
  loading: boolean;
  error: string | null;
  onSelect: (result: ChatFileMentionSearchResult) => void;
  onHighlight: (index: number) => void;
}) {
  return (
    <div
      id={id}
      className="absolute bottom-full left-3 right-3 z-50 mb-2 overflow-hidden rounded-xl border border-border bg-bg-elevated shadow-2xl ring-1 ring-black/20"
      role="listbox"
      aria-label="File mentions"
    >
      <div className="max-h-72 overflow-y-auto p-1.5">
        {loading && results.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-2.5 text-sm text-text-tertiary">
            <Loader2 size={14} className="animate-spin" />
            Searching files
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 px-3 py-2.5 text-sm text-warning">
            <AlertCircle size={14} />
            {error}
          </div>
        ) : results.length === 0 ? (
          <div className="px-3 py-2.5 text-sm text-text-tertiary">No matching files</div>
        ) : (
          results.map((result, index) => {
            const selected = index === selectedIndex;
            return (
              <button
                id={buildFileMentionOptionId(result)}
                key={`${result.repoId}:${result.relativePath}`}
                type="button"
                role="option"
                aria-selected={selected}
                onMouseEnter={() => onHighlight(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onSelect(result);
                }}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
                  selected
                    ? 'bg-accent/15 text-text-primary'
                    : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
                }`}
              >
                <FileIcon size={15} className={selected ? 'text-accent' : 'text-text-tertiary'} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs text-text-primary">
                    {result.relativePath}
                  </p>
                  <p className="truncate text-[11px] text-text-tertiary">
                    {result.repoName} - {formatAttachmentBytes(result.size)}
                  </p>
                </div>
              </button>
            );
          })
        )}
      </div>
      {loading && results.length > 0 && (
        <div className="border-t border-border-subtle px-3 py-1.5 text-[11px] text-text-tertiary">
          Refreshing results
        </div>
      )}
    </div>
  );
}

function SlashCommandMenu({
  id,
  results,
  selectedIndex,
  onSelect,
  onHighlight,
}: {
  id: string;
  results: ChatSlashCommand[];
  selectedIndex: number;
  onSelect: (command: ChatSlashCommand) => void;
  onHighlight: (index: number) => void;
}) {
  return (
    <div
      id={id}
      className="absolute bottom-full left-3 right-3 z-50 mb-2 overflow-hidden rounded-xl border border-border bg-bg-elevated shadow-2xl ring-1 ring-black/20"
      role="listbox"
      aria-label="Slash commands"
    >
      <div className="max-h-72 overflow-y-auto p-1.5">
        {results.length === 0 ? (
          <div className="px-3 py-2.5 text-sm text-text-tertiary">No matching commands</div>
        ) : (
          results.map((command, index) => {
            const selected = index === selectedIndex;
            return (
              <button
                id={buildSlashCommandOptionId(command)}
                key={command.id}
                type="button"
                role="option"
                aria-selected={selected}
                onMouseEnter={() => onHighlight(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onSelect(command);
                }}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
                  selected
                    ? 'bg-accent/15 text-text-primary'
                    : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
                }`}
              >
                <ListChecks size={15} className={selected ? 'text-accent' : 'text-text-tertiary'} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs text-text-primary">{command.command}</p>
                  <p className="truncate text-[11px] text-text-tertiary">
                    {command.label} - {command.description}
                  </p>
                </div>
                <ChevronRight size={14} className="text-text-muted" />
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function SkillMentionMenu({
  id,
  results,
  selectedIndex,
  loading,
  error,
  onSelect,
  onHighlight,
}: {
  id: string;
  results: CodexRegisteredSkill[];
  selectedIndex: number;
  loading: boolean;
  error: string | null;
  onSelect: (skill: CodexRegisteredSkill) => void;
  onHighlight: (index: number) => void;
}) {
  return (
    <div
      id={id}
      className="absolute bottom-full left-3 right-3 z-50 mb-2 overflow-hidden rounded-xl border border-border bg-bg-elevated shadow-2xl ring-1 ring-black/20"
      role="listbox"
      aria-label="Skill mentions"
    >
      <div className="max-h-72 overflow-y-auto p-1.5">
        {loading && results.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-2.5 text-sm text-text-tertiary">
            <Loader2 size={14} className="animate-spin" />
            Loading skills
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 px-3 py-2.5 text-sm text-warning">
            <AlertCircle size={14} />
            {error}
          </div>
        ) : results.length === 0 ? (
          <div className="px-3 py-2.5 text-sm text-text-tertiary">No matching skills</div>
        ) : (
          results.map((skill, index) => {
            const selected = index === selectedIndex;
            return (
              <button
                id={buildSkillMentionOptionId(skill)}
                key={skill.id}
                type="button"
                role="option"
                aria-selected={selected}
                onMouseEnter={() => onHighlight(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onSelect(skill);
                }}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
                  selected
                    ? 'bg-accent/15 text-text-primary'
                    : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
                }`}
              >
                <Sparkles size={15} className={selected ? 'text-accent' : 'text-text-tertiary'} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs text-text-primary">${skill.name}</p>
                  <p className="truncate text-[11px] text-text-tertiary">
                    {scopeLabel(skill.scope)}
                    {skill.description ? ` - ${skill.description}` : ''}
                  </p>
                </div>
              </button>
            );
          })
        )}
      </div>
      {loading && results.length > 0 && (
        <div className="border-t border-border-subtle px-3 py-1.5 text-[11px] text-text-tertiary">
          Refreshing skills
        </div>
      )}
    </div>
  );
}

function extractClipboardFiles(dataTransfer: DataTransfer): File[] {
  const files = Array.from(dataTransfer.files);
  if (files.length > 0) return files;

  return Array.from(dataTransfer.items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
}

async function fileToAttachmentInput(file: File): Promise<{
  input: ChatAttachmentInput;
  previewDataUrl?: string;
}> {
  if (file.size > MAX_RENDERER_ATTACHMENT_BYTES) {
    throw new Error(`${file.name || 'Attachment'} is larger than 25 MB.`);
  }

  const id = generateAttachmentId();
  const filePath = getElectronFilePath(file);
  const name = file.name || defaultAttachmentName(file, id);
  const input: ChatAttachmentInput = {
    id,
    name,
    mimeType: file.type,
    size: file.size,
  };

  if (filePath) {
    return { input: { ...input, path: filePath } };
  }

  const dataUrl = await readFileAsDataUrl(file);
  return {
    input: { ...input, dataUrl },
    previewDataUrl: isImageFile(file) ? dataUrl : undefined,
  };
}

function getElectronFilePath(file: File): string | undefined {
  const candidate = (file as File & { path?: unknown }).path;
  return typeof candidate === 'string' && candidate.trim() ? candidate : undefined;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
        return;
      }
      reject(new Error('Failed to read attachment.'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read attachment.'));
    reader.readAsDataURL(file);
  });
}

function defaultAttachmentName(file: File, id: string): string {
  const extension = extensionForMime(file.type);
  return `${file.type.startsWith('image/') ? 'pasted-image' : 'pasted-file'}-${id}${extension}`;
}

function extensionForMime(mimeType: string): string {
  switch (mimeType) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    case 'text/plain':
      return '.txt';
    default:
      return '';
  }
}

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/');
}

function mergeAttachments(
  currentAttachments: ChatAttachment[],
  nextAttachments: ChatAttachment[],
): ChatAttachment[] {
  const seen = new Set(currentAttachments.map(getAttachmentDedupKey));
  return [
    ...currentAttachments,
    ...nextAttachments.filter((attachment) => {
      const key = getAttachmentDedupKey(attachment);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  ].slice(0, MAX_ATTACHMENT_COUNT);
}

function getAttachmentDedupKey(attachment: ChatAttachment): string {
  return attachment.path || attachment.id;
}

function generateAttachmentId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${kilobytes.toFixed(1)} KB`;
  return `${(kilobytes / 1024).toFixed(1)} MB`;
}

function findActiveFileMention(
  value: string,
  selectionStart: number | null,
): ActiveFileMention | null {
  if (selectionStart === null) return null;

  const beforeCaret = value.slice(0, selectionStart);
  const match = beforeCaret.match(/(^|\s)@([^\s@]*)$/);
  if (!match) return null;

  const query = match[2] ?? '';
  return {
    start: beforeCaret.length - query.length - 1,
    end: selectionStart,
    query,
  };
}

export function findActiveSlashCommand(
  value: string,
  selectionStart: number | null,
): ActiveTextTrigger | null {
  if (selectionStart === null) return null;

  const beforeCaret = value.slice(0, selectionStart);
  const match = beforeCaret.match(/^\/([^\s/]*)$/);
  if (!match) return null;

  return {
    start: 0,
    end: selectionStart,
    query: match[1] ?? '',
  };
}

export function findActiveSkillMention(
  value: string,
  selectionStart: number | null,
): ActiveTextTrigger | null {
  if (selectionStart === null) return null;

  const beforeCaret = value.slice(0, selectionStart);
  const match = beforeCaret.match(/(^|\s)\$([^\s$]*)$/);
  if (!match) return null;

  const query = match[2] ?? '';
  return {
    start: beforeCaret.length - query.length - 1,
    end: selectionStart,
    query,
  };
}

function buildFileMentionLabel(
  result: ChatFileMentionSearchResult,
  includeRepoName: boolean,
): string {
  return includeRepoName ? `${result.repoName}/${result.relativePath}` : result.relativePath;
}

export function getSlashCommandResults(
  commands: ChatSlashCommand[],
  query: string,
  limit = 8,
): ChatSlashCommand[] {
  const normalizedQuery = query.toLowerCase();
  return commands
    .filter((command) => {
      if (!normalizedQuery) return true;
      return [command.command, command.label, command.description]
        .join(' ')
        .toLowerCase()
        .includes(normalizedQuery);
    })
    .slice(0, limit);
}

export function getSkillMentionResults(
  skills: CodexRegisteredSkill[],
  query: string,
  limit = 12,
): CodexRegisteredSkill[] {
  const normalizedQuery = query.toLowerCase();
  return skills
    .filter((skill) => {
      if (!normalizedQuery) return true;
      return [skill.name, skill.description, skill.scope, skill.source]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(normalizedQuery);
    })
    .slice(0, limit);
}

export function shouldSendChatMessageFromKey(event: ChatComposerKeyEvent): boolean {
  return event.key === 'Enter' && !event.shiftKey;
}

export function buildFileMentionOptionId(result: ChatFileMentionSearchResult): string {
  return `chat-file-mention-option-${slugForDomId(result.repoId)}-${slugForDomId(
    result.relativePath,
  )}`;
}

export function buildSlashCommandOptionId(command: ChatSlashCommand): string {
  return `chat-slash-command-option-${slugForDomId(command.id)}`;
}

export function buildSkillMentionOptionId(skill: CodexRegisteredSkill): string {
  return `chat-skill-mention-option-${slugForDomId(skill.id)}`;
}

function scopeLabel(scope: CodexRegisteredSkill['scope']): string {
  switch (scope) {
    case 'codex-global':
      return 'Global skill';
    case 'codex-system':
      return 'System skill';
    case 'user-agents':
      return 'User skill';
    case 'project':
      return 'Project skill';
    case 'plugin':
      return 'Plugin skill';
    default:
      return 'Skill';
  }
}

const RUN_SETTINGS_MENU_ID = 'chat-run-settings-menu';

const REASONING_EFFORT_OPTIONS: { level: ReasoningEffort; description: string }[] = [
  { level: 'none', description: 'Fastest; no extended reasoning' },
  { level: 'minimal', description: 'Very light reasoning for trivial tasks' },
  { level: 'low', description: 'Light reasoning, quick responses' },
  { level: 'medium', description: 'Balanced default for everyday work' },
  { level: 'high', description: 'Deeper reasoning for complex tasks' },
  { level: 'xhigh', description: 'Extra high reasoning for difficult tradeoffs' },
  { level: 'max', description: 'Maximum single-agent depth for hard problems' },
  { level: 'ultra', description: 'Subagent-backed effort for splittable work' },
];

export function getRunSettingsLabel(
  executionStrategy: ExecutionStrategy,
  reasoningLevel: ReasoningEffort,
): string {
  const strategy = EXECUTION_STRATEGIES.find((option) => option.id === executionStrategy);
  return `${strategy?.label ?? executionStrategy} · ${reasoningLevel}`;
}

function RunSettingsDropdown({
  executionStrategy,
  onExecutionStrategyChange,
  reasoningLevel,
  reasoningOptions = REASONING_EFFORT_OPTIONS.map((option) => option.level),
  onReasoningChange,
}: {
  executionStrategy: ExecutionStrategy;
  onExecutionStrategyChange?: (strategy: ExecutionStrategy) => void;
  reasoningLevel: ReasoningEffort;
  reasoningOptions?: ReasoningEffort[];
  onReasoningChange?: (level: ReasoningEffort) => void;
}) {
  const availableOptions = REASONING_EFFORT_OPTIONS.filter((option) =>
    reasoningOptions.includes(option.level),
  );
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (open && event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  };

  const label = getRunSettingsLabel(executionStrategy, reasoningLevel);

  return (
    <div ref={containerRef} className="relative" onKeyDown={handleKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex h-9 max-w-36 items-center gap-1.5 rounded-xl border border-border bg-bg-secondary px-2.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
        title="Run settings"
        aria-label={`Run settings: ${label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? RUN_SETTINGS_MENU_ID : undefined}
      >
        <SlidersHorizontal size={13} className="shrink-0 text-text-tertiary" />
        <span className="truncate capitalize">{label}</span>
        <ChevronDown
          size={12}
          className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          id={RUN_SETTINGS_MENU_ID}
          className="absolute bottom-full right-0 z-50 mb-2 w-72 rounded-xl border border-border bg-bg-elevated p-3 shadow-2xl ring-1 ring-black/20"
          role="dialog"
          aria-label="Run settings"
        >
          <div className="space-y-3">
            {onExecutionStrategyChange && (
              <label className="block">
                <span className="mb-1 block text-[11px] font-medium text-text-muted">
                  Execution
                </span>
                <select
                  value={executionStrategy}
                  onChange={(event) =>
                    onExecutionStrategyChange(event.target.value as ExecutionStrategy)
                  }
                  className="h-9 w-full rounded-lg border border-border bg-bg-secondary px-2.5 text-xs text-text-primary outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
                >
                  {EXECUTION_STRATEGIES.map((strategy) => (
                    <option key={strategy.id} value={strategy.id}>
                      {strategy.label}
                    </option>
                  ))}
                </select>
                <span className="mt-1 block text-[11px] leading-4 text-text-tertiary">
                  {
                    EXECUTION_STRATEGIES.find((strategy) => strategy.id === executionStrategy)
                      ?.description
                  }
                </span>
              </label>
            )}

            {onReasoningChange && availableOptions.length > 0 && (
              <label className="block">
                <span className="mb-1 block text-[11px] font-medium text-text-muted">
                  Reasoning
                </span>
                <select
                  value={reasoningLevel}
                  onChange={(event) => onReasoningChange(event.target.value as ReasoningEffort)}
                  className="h-9 w-full rounded-lg border border-border bg-bg-secondary px-2.5 text-xs capitalize text-text-primary outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
                >
                  {availableOptions.map((option) => (
                    <option key={option.level} value={option.level}>
                      {option.level}
                    </option>
                  ))}
                </select>
                <span className="mt-1 block text-[11px] leading-4 text-text-tertiary">
                  {availableOptions.find((option) => option.level === reasoningLevel)?.description}
                </span>
              </label>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

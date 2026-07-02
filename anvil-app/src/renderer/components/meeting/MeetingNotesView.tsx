import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ClipboardList,
  GitBranch,
  ListChecks,
  MessageSquareText,
  Mic,
  MicOff,
  Search,
  Sparkles,
} from 'lucide-react';
import { useVoiceInput } from '../../hooks/useVoiceInput';

interface ParsedNotes {
  summary: string[];
  actions: string[];
  keyPoints: string[];
  spikeCandidates: string[];
}

type MeetingChatMode = 'summary' | 'actions' | 'ba' | 'spike';

const ACTION_PATTERN = /\b(action|todo|owner|follow up|follow-up|next step|will|assign(?:ed)?)\b/i;
const SPIKE_TRIGGER_PATTERN =
  /\b(spike|investigate|research|unknown|unclear|ambiguous|ambiguity|risk|risky|blocked|blocker|dependency|depends|compliance|legal|security|feasibility|open question|assumption|tbc|not sure|needs discovery)\b/i;

export function parseMeetingNotes(transcript: string): ParsedNotes {
  const cleaned = transcript.replace(/\s+/g, ' ').trim();
  if (!cleaned) return { summary: [], actions: [], keyPoints: [], spikeCandidates: [] };
  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    summary: sentences.slice(0, 4),
    actions: sentences.filter((s) => ACTION_PATTERN.test(s)),
    keyPoints: sentences.filter((s) => s.length > 50).slice(0, 8),
    spikeCandidates: sentences.filter((s) => SPIKE_TRIGGER_PATTERN.test(s)).slice(0, 8),
  };
}

export function buildMeetingChatPath(
  mode: MeetingChatMode,
  transcript: string,
  detail?: string,
): string {
  const context = transcript.slice(0, 8000);
  const promptByMode: Record<MeetingChatMode, string> = {
    summary: `Use these meeting notes as context:\n\n${context}\n\nPlease provide a concise executive summary, risks, and open questions.`,
    actions: `Use these meeting notes as context:\n\n${context}\n\nExtract action items. For each one include the likely owner, next step, urgency, and whether it should become a tracked work item. Do not invent missing details.`,
    ba: `Use these meeting notes as context:\n\n${context}\n\nAs a BA, deep-dive this key point: ${detail ?? 'Identify the highest-risk ambiguity and ask clarifying questions.'}`,
    spike: `Use these meeting notes as context:\n\n${context}\n\nCandidate spike trigger: ${detail ?? 'Identify the highest-risk ambiguity.'}\n\nDecide whether this needs a BA spike. Explain the risk, the smallest useful spike scope, acceptance evidence, and the first questions to answer. If it should become a tracked item, draft a title and description.`,
  };
  const params = new URLSearchParams({ prompt: promptByMode[mode] });
  if (mode === 'ba' || mode === 'spike') params.set('persona', 'ba');
  return `/chat?${params.toString()}`;
}

export function MeetingNotesView() {
  const navigate = useNavigate();
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const parsed = useMemo(() => parseMeetingNotes(transcript), [transcript]);
  const {
    isSupported,
    isListening,
    transcript: liveTranscript,
    startListening,
    stopListening,
  } = useVoiceInput({
    onResult: (text) =>
      setTranscript((current) => `${current}${current ? '\n' : ''}${text}`.trim()),
    onError: (message) => setError(message),
  });
  const hasTranscript = transcript.trim().length > 0;
  const wordCount = hasTranscript ? transcript.trim().split(/\s+/).length : 0;

  const openInChat = (mode: MeetingChatMode, detail?: string) => {
    if (!hasTranscript) {
      setError('Add meeting notes before sending them to chat.');
      return;
    }
    navigate(buildMeetingChatPath(mode, transcript, detail));
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-primary text-text-primary">
      <header className="border-b border-border px-6 py-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">Meeting Notes</h1>
            <p className="mt-1 max-w-2xl text-sm text-text-secondary">
              Capture the transcript, extract the obvious work, then hand off the unclear bits to
              chat or BA spike prep.
            </p>
          </div>
          <div className="grid grid-cols-3 overflow-hidden rounded-lg border border-border bg-bg-secondary">
            <Metric label="Words" value={wordCount} />
            <Metric label="Actions" value={parsed.actions.length} />
            <Metric label="Spikes" value={parsed.spikeCandidates.length} />
          </div>
        </div>
      </header>

      <main className="grid min-h-0 flex-1 gap-4 p-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
        <section className="flex min-h-0 flex-col rounded-lg border border-border bg-bg-secondary">
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold">Capture</h2>
              <p className="text-xs text-text-tertiary">
                Paste notes or use browser voice capture.
              </p>
            </div>
            <button
              onClick={isListening ? stopListening : startListening}
              disabled={!isSupported}
              className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
              title={isSupported ? undefined : 'Voice capture is not available in this runtime'}
              aria-label={isListening ? 'Stop voice capture' : 'Start voice capture'}
            >
              {isListening ? <MicOff size={14} /> : <Mic size={14} />}
              {isListening ? 'Stop' : 'Record'}
            </button>
          </div>
          <textarea
            value={transcript}
            onChange={(e) => {
              setTranscript(e.target.value);
              setError(null);
            }}
            className="min-h-0 flex-1 resize-none border-0 bg-bg-primary p-4 text-sm leading-relaxed text-text-primary placeholder:text-text-tertiary focus:outline-none"
            placeholder="Paste transcript or type notes here..."
          />
          <div className="min-h-10 border-t border-border px-4 py-2 text-xs">
            {liveTranscript ? (
              <p className="text-text-tertiary">Listening: {liveTranscript}</p>
            ) : !isSupported ? (
              <p className="text-text-tertiary">
                Voice capture is not available here. Paste or type notes instead.
              </p>
            ) : error ? (
              <p className="text-error">{error}</p>
            ) : (
              <p className="text-text-tertiary">
                Spike triggers: ambiguity, risk, dependency, compliance, security, feasibility,
                blocked work, or explicit investigate/research language.
              </p>
            )}
          </div>
        </section>

        <section className="min-h-0 space-y-4 overflow-auto">
          <div className="rounded-lg border border-border bg-bg-secondary p-3">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium">
              <MessageSquareText size={14} />
              Send To Chat
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <CommandButton
                icon={<Sparkles size={14} />}
                label="Summarise"
                disabled={!hasTranscript}
                onClick={() => openInChat('summary')}
              />
              <CommandButton
                icon={<ClipboardList size={14} />}
                label="Extract Actions"
                disabled={!hasTranscript}
                onClick={() => openInChat('actions')}
              />
            </div>
          </div>

          <Panel
            title="Summary"
            icon={<Sparkles size={14} />}
            items={parsed.summary}
            empty="No summary yet."
          />

          <Panel
            title="Actions"
            icon={<ListChecks size={14} />}
            items={parsed.actions}
            empty="No action items found."
            action={
              <button
                className="rounded-md border border-border px-2 py-1 text-xs text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
                onClick={() => openInChat('actions')}
                disabled={!hasTranscript}
              >
                Draft Tracker
              </button>
            }
          />

          <div className="rounded-lg border border-border bg-bg-secondary p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Search size={14} />
                  Spike Candidates
                </div>
                <p className="mt-1 text-xs leading-relaxed text-text-tertiary">
                  A spike is suggested when notes contain unresolved risk, ambiguity, blocked work,
                  external dependency, compliance/security/legal concern, feasibility doubt, or
                  explicit research language.
                </p>
              </div>
              <GitBranch size={14} className="mt-1 shrink-0 text-text-tertiary" />
            </div>
            <div className="mt-3 rounded-md border border-border bg-bg-primary p-2 text-xs text-text-secondary">
              Work-item BA spikes run in retained git worktrees. Meeting-note spike prompts prepare
              the scope; the actual spike session starts from a linked work item.
            </div>
            <ListWithActions
              items={parsed.spikeCandidates}
              empty="No spike triggers found."
              actionLabel="Assess Spike"
              onAction={(item) => openInChat('spike', item)}
            />
          </div>

          <Panel
            title="BA Follow-up"
            icon={<AlertTriangle size={14} />}
            items={parsed.keyPoints.slice(0, 4)}
            empty="Longer key points will appear here."
            action={
              <button
                className="rounded-md border border-border px-2 py-1 text-xs text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
                onClick={() =>
                  openInChat('ba', parsed.keyPoints[0] ?? 'Identify the highest-risk ambiguity.')
                }
                disabled={!hasTranscript}
              >
                Ask BA
              </button>
            }
          />
        </section>
      </main>
    </div>
  );
}

function Panel({
  title,
  icon,
  items,
  empty,
  action,
}: {
  title: string;
  icon: ReactNode;
  items: string[];
  empty: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-bg-secondary p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          {icon}
          {title}
        </div>
        {action}
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-text-tertiary">{empty}</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {items.map((item, index) => (
            <li
              key={`${title}-${index}`}
              className="rounded-md border border-border bg-bg-primary px-3 py-2 leading-relaxed"
            >
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ListWithActions({
  items,
  empty,
  actionLabel,
  onAction,
}: {
  items: string[];
  empty: string;
  actionLabel: string;
  onAction: (item: string) => void;
}) {
  if (items.length === 0) {
    return <p className="mt-3 text-xs text-text-tertiary">{empty}</p>;
  }

  return (
    <div className="mt-3 space-y-2">
      {items.map((item, index) => (
        <div
          key={`${index}-${item}`}
          className="rounded-md border border-border bg-bg-primary p-3 text-sm"
        >
          <p className="leading-relaxed">{item}</p>
          <button
            className="mt-2 rounded-md border border-border px-2 py-1 text-xs text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
            onClick={() => onAction(item)}
          >
            {actionLabel}
          </button>
        </div>
      ))}
    </div>
  );
}

function CommandButton({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="inline-flex items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="border-r border-border px-4 py-2 last:border-r-0">
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-[11px] uppercase text-text-tertiary">{label}</div>
    </div>
  );
}

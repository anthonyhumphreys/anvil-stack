import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mic, MicOff, MessageSquareText, ClipboardList, Sparkles } from 'lucide-react';
import { useVoiceInput } from '../../hooks/useVoiceInput';

interface ParsedNotes { summary: string[]; actions: string[]; keyPoints: string[] }

function parseMeetingNotes(transcript: string): ParsedNotes {
  const cleaned = transcript.replace(/\s+/g, ' ').trim();
  if (!cleaned) return { summary: [], actions: [], keyPoints: [] };
  const sentences = cleaned.split(/(?<=[.!?])\s+/).map((item) => item.trim()).filter(Boolean);
  return {
    summary: sentences.slice(0, 4),
    actions: sentences.filter((s) => /\b(action|todo|owner|follow up|next step|will)\b/i.test(s)),
    keyPoints: sentences.filter((s) => s.length > 50).slice(0, 8),
  };
}

export function MeetingNotesView() {
  const navigate = useNavigate();
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const parsed = useMemo(() => parseMeetingNotes(transcript), [transcript]);
  const { isSupported, isListening, transcript: liveTranscript, startListening, stopListening } = useVoiceInput({
    onResult: (text) => setTranscript((current) => `${current}${current ? '\n' : ''}${text}`.trim()),
    onError: (message) => setError(message),
  });

  const openInChat = (mode: 'summary' | 'actions' | 'ba', detail?: string) => {
    const context = transcript.slice(0, 8000);
    const promptByMode = {
      summary: `Use these meeting notes as context:\n\n${context}\n\nPlease provide a concise executive summary, risks, and open questions.`,
      actions: `Use these meeting notes as context:\n\n${context}\n\nExtract action items with owner suggestions, urgency, and a proposed tracking format.`,
      ba: `Use these meeting notes as context:\n\n${context}\n\nAs a BA, deep-dive this key point: ${detail ?? 'Identify the highest-risk ambiguity and ask clarifying questions.'}`,
    };
    navigate(mode === 'ba' ? '/chat?persona=ba' : '/chat', {
      state: { prompt: promptByMode[mode] },
    });
  };

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col gap-4 p-6 text-text-primary">
      <h1 className="text-2xl font-semibold">Meeting Notes</h1>
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-border bg-bg-secondary p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase">Raw notes</h2>
            <button onClick={isListening ? stopListening : startListening} disabled={!isSupported} className="rounded-lg border border-border px-3 py-1.5 text-sm disabled:opacity-50">{isListening ? <MicOff className="mr-1 inline" size={14} /> : <Mic className="mr-1 inline" size={14} />}{isListening ? 'Stop voice capture' : 'Start voice capture'}</button>
          </div>
          <textarea value={transcript} onChange={(e) => setTranscript(e.target.value)} className="h-[26rem] w-full rounded-lg border border-border bg-bg-primary p-3 text-sm" placeholder="Paste transcript or type notes here..." />
          {liveTranscript && <p className="mt-2 text-xs text-text-tertiary">Listening: {liveTranscript}</p>}
          {error && <p className="mt-2 text-xs text-danger">{error}</p>}
        </section>
        <section className="space-y-4 rounded-xl border border-border bg-bg-secondary p-4">
          <Panel title="Summary" icon={<Sparkles size={14} />} items={parsed.summary} empty="No summary yet." />
          <Panel title="Actions" icon={<ClipboardList size={14} />} items={parsed.actions} empty="No action items found." />
          <div className="rounded-lg border border-border p-3">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium"><MessageSquareText size={14} />Follow-up in chat</div>
            <div className="flex gap-2">
              <button className="rounded-md border border-border px-3 py-1.5 text-xs" onClick={() => openInChat('summary')}>Send summary request</button>
              <button className="rounded-md border border-border px-3 py-1.5 text-xs" onClick={() => openInChat('actions')}>Send action extraction</button>
            </div>
            <div className="mt-3 space-y-1">{parsed.keyPoints.slice(0, 4).map((point, i) => <button key={`${i}-${point}`} className="block w-full rounded-md border border-border px-2 py-1 text-left text-xs" onClick={() => openInChat('ba', point)}>Ask BA to explore: {point.slice(0, 100)}</button>)}</div>
          </div>
        </section>
      </div>
    </div>
  );
}

function Panel({ title, icon, items, empty }: { title: string; icon: ReactNode; items: string[]; empty: string }) {
  return <div className="rounded-lg border border-border p-3"><div className="mb-2 flex items-center gap-2 text-sm font-medium">{icon}{title}</div>{items.length === 0 ? <p className="text-xs text-text-tertiary">{empty}</p> : <ul className="list-disc space-y-1 pl-4 text-sm">{items.map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}</ul>}</div>;
}

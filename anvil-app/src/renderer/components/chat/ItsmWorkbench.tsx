import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, ClipboardList, FileWarning, Send, Trash2 } from 'lucide-react';

type ItsmRecordType = 'incident' | 'request' | 'problem' | 'change' | 'service';

export interface ItsmContext {
  service: string;
  impact: string;
  summary: string;
  evidence: string;
  ownership: string;
}

interface ItsmWorkbenchProps {
  workspaceId: string | null;
  onPrompt: (prompt: string) => void;
}

const EMPTY_CONTEXT: ItsmContext = {
  service: '',
  impact: '',
  summary: '',
  evidence: '',
  ownership: '',
};

const RECORD_TYPES: Array<{ id: ItsmRecordType; label: string }> = [
  { id: 'incident', label: 'Incident' },
  { id: 'request', label: 'Request' },
  { id: 'problem', label: 'Problem' },
  { id: 'change', label: 'Change' },
  { id: 'service', label: 'Service' },
];

const ACTIONS: Record<ItsmRecordType, Array<{ label: string; instruction: string }>> = {
  incident: [
    { label: 'Triage', instruction: 'Triage this incident and identify the safest next actions.' },
    { label: 'Status update', instruction: 'Draft a concise stakeholder incident update.' },
    { label: 'Escalation pack', instruction: 'Prepare a complete technical escalation pack.' },
  ],
  request: [
    {
      label: 'Clarify request',
      instruction: 'Clarify this request, its outcome, and missing information.',
    },
    {
      label: 'Fulfilment brief',
      instruction: 'Prepare a fulfilment brief with ownership and checks.',
    },
  ],
  problem: [
    { label: 'Problem analysis', instruction: 'Structure an evidence-led problem analysis.' },
    {
      label: 'Known error',
      instruction: 'Draft a known-error record and safe workaround guidance.',
    },
  ],
  change: [
    {
      label: 'Risk review',
      instruction: 'Assess this change for risk, gaps, and required evidence.',
    },
    {
      label: 'Backout check',
      instruction: 'Challenge the backout plan, stop conditions, and validation.',
    },
  ],
  service: [
    {
      label: 'Service review',
      instruction: 'Prepare a service review from the available evidence.',
    },
    {
      label: 'Improvement plan',
      instruction: 'Turn these service themes into measurable improvements.',
    },
  ],
};

export function ItsmWorkbench({ workspaceId, onPrompt }: ItsmWorkbenchProps) {
  const [recordType, setRecordType] = useState<ItsmRecordType>('incident');
  const [context, setContext] = useState<ItsmContext>(EMPTY_CONTEXT);
  const [loadedWorkspaceId, setLoadedWorkspaceId] = useState<string | null>(null);
  const storageKey = useMemo(
    () => `anvil:itsm-workbench:${workspaceId ?? 'no-workspace'}`,
    [workspaceId],
  );

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored) {
        const parsed = parseStoredItsmWorkbench(JSON.parse(stored));
        setRecordType(parsed.recordType);
        setContext(parsed.context);
      } else {
        setRecordType('incident');
        setContext(EMPTY_CONTEXT);
      }
    } catch {
      setRecordType('incident');
      setContext(EMPTY_CONTEXT);
    } finally {
      setLoadedWorkspaceId(workspaceId);
    }
  }, [storageKey, workspaceId]);

  useEffect(() => {
    if (loadedWorkspaceId !== workspaceId) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify({ recordType, context }));
    } catch {
      // The workbench remains usable when local storage is unavailable or full.
    }
  }, [context, loadedWorkspaceId, recordType, storageKey, workspaceId]);

  const updateContext = (field: keyof ItsmContext, value: string) => {
    setContext((current) => ({ ...current, [field]: value }));
  };

  const clearContext = () => {
    if (!window.confirm('Clear the saved ITSM context for this workspace?')) return;
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // Clearing the in-memory context is still useful when storage is unavailable.
    }
    setRecordType('incident');
    setContext(EMPTY_CONTEXT);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border/60 px-3 py-3">
        <p className="text-xs leading-relaxed text-text-tertiary">
          Shape evidence and handovers beside Chat. Saved locally for this workspace.
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5" aria-label="ITSM record type">
          {RECORD_TYPES.map((type) => (
            <button
              key={type.id}
              type="button"
              onClick={() => setRecordType(type.id)}
              aria-pressed={recordType === type.id}
              className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                recordType === type.id
                  ? 'bg-accent/15 text-accent'
                  : 'bg-bg-primary text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary'
              }`}
            >
              {type.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        <section>
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-text-secondary">
            <ClipboardList size={13} />
            Context
          </div>
          <div className="space-y-2.5">
            <WorkbenchField
              label="Service or scope"
              value={context.service}
              placeholder="Affected service, system, team, or user group"
              onChange={(value) => updateContext('service', value)}
            />
            <WorkbenchField
              label="Impact and urgency"
              value={context.impact}
              placeholder="Who is affected, how badly, and since when?"
              onChange={(value) => updateContext('impact', value)}
              multiline
            />
            <WorkbenchField
              label="Summary and timeline"
              value={context.summary}
              placeholder="Symptoms or requested outcome, key times, recent changes"
              onChange={(value) => updateContext('summary', value)}
              multiline
            />
            <WorkbenchField
              label="Evidence and actions tried"
              value={context.evidence}
              placeholder="Logs, links, observations, checks, results, workarounds"
              onChange={(value) => updateContext('evidence', value)}
              multiline
            />
            <WorkbenchField
              label="Owner and next update"
              value={context.ownership}
              placeholder="Current owner, escalation target, next update time"
              onChange={(value) => updateContext('ownership', value)}
            />
          </div>
        </section>

        <div className="rounded-lg border border-warning/25 bg-warning/5 px-3 py-2.5">
          <p className="flex items-start gap-2 text-xs leading-relaxed text-text-tertiary">
            <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warning" />
            Keep secrets and unnecessary personal data out. The draft is saved on this device;
            sending it adds the content to Chat and your configured AI provider.
          </p>
        </div>

        <section>
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-text-secondary">
            <FileWarning size={13} />
            Send to chat
          </div>
          <div className="space-y-1.5">
            {ACTIONS[recordType].map((action) => (
              <button
                key={action.label}
                type="button"
                onClick={() =>
                  onPrompt(buildItsmContextPrompt(recordType, action.instruction, context))
                }
                className="group flex w-full items-center justify-between gap-3 rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-left text-sm text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <span>{action.label}</span>
                <ArrowRight
                  size={13}
                  className="shrink-0 text-text-tertiary transition-transform group-hover:translate-x-0.5"
                />
              </button>
            ))}
          </div>
        </section>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border/60 px-3 py-2.5">
        <button
          type="button"
          onClick={clearContext}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-text-tertiary transition-colors hover:bg-error/10 hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error/40"
        >
          <Trash2 size={12} />
          Clear
        </button>
        <button
          type="button"
          onClick={() =>
            onPrompt(
              buildItsmContextPrompt(
                recordType,
                'Review this context, identify material gaps, and recommend the next safe action.',
                context,
              ),
            )
          }
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          <Send size={12} />
          Review context
        </button>
      </div>
    </div>
  );
}

interface WorkbenchFieldProps {
  label: string;
  value: string;
  placeholder: string;
  multiline?: boolean;
  onChange: (value: string) => void;
}

function WorkbenchField({ label, value, placeholder, multiline, onChange }: WorkbenchFieldProps) {
  const className =
    'w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent/50 focus:outline-none focus:ring-2 focus:ring-accent/20';

  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-text-secondary">{label}</span>
      {multiline ? (
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          rows={3}
          className={`${className} resize-y`}
        />
      ) : (
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className={className}
        />
      )}
    </label>
  );
}

export function buildItsmContextPrompt(
  recordType: ItsmRecordType,
  instruction: string,
  context: ItsmContext,
): string {
  const fields = [
    ['Service or scope', context.service],
    ['Impact and urgency', context.impact],
    ['Summary and timeline', context.summary],
    ['Evidence and actions tried', context.evidence],
    ['Owner and next update', context.ownership],
  ].filter(([, value]) => value.trim().length > 0);

  const contextBlock =
    fields.length > 0
      ? fields.map(([label, value]) => `## ${label}\n${value.trim()}`).join('\n\n')
      : 'No structured context has been captured yet. Start by asking for the minimum missing information.';

  return [
    instruction,
    '',
    `Record type: ${recordType}`,
    '',
    contextBlock,
    '',
    'Separate confirmed evidence from reports, assumptions, and hypotheses. Do not claim that any action, approval, update, or resolution occurred without evidence.',
  ].join('\n');
}

export function parseStoredItsmWorkbench(value: unknown): {
  recordType: ItsmRecordType;
  context: ItsmContext;
} {
  const candidate = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const recordType = isItsmRecordType(candidate.recordType) ? candidate.recordType : 'incident';
  const rawContext =
    candidate.context && typeof candidate.context === 'object'
      ? (candidate.context as Record<string, unknown>)
      : {};

  return {
    recordType,
    context: {
      service: stringValue(rawContext.service),
      impact: stringValue(rawContext.impact),
      summary: stringValue(rawContext.summary),
      evidence: stringValue(rawContext.evidence),
      ownership: stringValue(rawContext.ownership),
    },
  };
}

function isItsmRecordType(value: unknown): value is ItsmRecordType {
  return RECORD_TYPES.some(({ id }) => id === value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Bot, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import type { EditableAgent, EditableAgentInput } from '../../../shared/types';

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface AgentFormState {
  name: string;
  description: string;
  icon: string;
  colour: string;
  promptBody: string;
  canWriteFiles: boolean;
  canRunCommands: boolean;
  canReadFiles: boolean;
}

const EMPTY_FORM: AgentFormState = {
  name: '',
  description: '',
  icon: 'Bot',
  colour: '#64748b',
  promptBody: '',
  canWriteFiles: true,
  canRunCommands: true,
  canReadFiles: true,
};

function toFormState(agent: EditableAgent): AgentFormState {
  return {
    name: agent.name,
    description: agent.description,
    icon: agent.icon,
    colour: agent.colour,
    promptBody: agent.promptBody,
    canWriteFiles: agent.capabilities.canWriteFiles,
    canRunCommands: agent.capabilities.canRunCommands,
    canReadFiles: agent.capabilities.canReadFiles,
  };
}

const INPUT_CLASS =
  'w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none';

/**
 * Minimal editable-agent editor. Agents render as personas everywhere personas
 * resolve and sync through the `editable-agent` entity when Sync is enabled.
 */
export function EditableAgentsPanel(): ReactNode {
  const [agents, setAgents] = useState<EditableAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<AgentFormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      setAgents(await window.anvil.agents.list());
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const startCreate = (): void => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
    setError(null);
  };

  const startEdit = (agent: EditableAgent): void => {
    setEditingId(agent.id);
    setForm(toFormState(agent));
    setError(null);
  };

  const handleSave = async (): Promise<void> => {
    if (!form) return;
    setSaving(true);
    setError(null);
    const input: EditableAgentInput = {
      name: form.name,
      description: form.description,
      icon: form.icon,
      colour: form.colour,
      promptBody: form.promptBody,
      capabilities: {
        canWriteFiles: form.canWriteFiles,
        canRunCommands: form.canRunCommands,
        canReadFiles: form.canReadFiles,
      },
    };
    try {
      await window.anvil.agents.save(input, editingId ?? undefined);
      setForm(null);
      setEditingId(null);
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (agent: EditableAgent): Promise<void> => {
    setError(null);
    try {
      await window.anvil.agents.delete(agent.id);
      if (editingId === agent.id) {
        setForm(null);
        setEditingId(null);
      }
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err));
    }
  };

  const updateForm = (patch: Partial<AgentFormState>): void => {
    setForm((current) => (current ? { ...current, ...patch } : current));
  };

  return (
    <div className="space-y-3">
      {loading && (
        <p className="flex items-center gap-2 text-sm text-text-tertiary">
          <Loader2 size={14} className="animate-spin" /> Loading agents…
        </p>
      )}

      {!loading && agents.length === 0 && form === null && (
        <p className="text-sm text-text-tertiary">
          No custom agents yet. Agents you create appear anywhere personas can be selected and sync
          to your other devices when Sync is enabled.
        </p>
      )}

      <ul className="space-y-2">
        {agents.map((agent) => (
          <li
            key={agent.id}
            className="flex items-center gap-3 rounded-md border border-border bg-bg-primary px-3 py-2"
          >
            <span
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-white"
              style={{ backgroundColor: agent.colour }}
            >
              <Bot size={14} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-text-primary">
                {agent.name}
              </span>
              {agent.description && (
                <span className="block truncate text-xs text-text-tertiary">
                  {agent.description}
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={() => startEdit(agent)}
              className="rounded p-1.5 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
              aria-label={`Edit ${agent.name}`}
            >
              <Pencil size={14} />
            </button>
            <button
              type="button"
              onClick={() => void handleDelete(agent)}
              className="rounded p-1.5 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-error"
              aria-label={`Delete ${agent.name}`}
            >
              <Trash2 size={14} />
            </button>
          </li>
        ))}
      </ul>

      {form === null && !loading && (
        <button
          type="button"
          onClick={startCreate}
          className="flex items-center gap-1.5 rounded-md border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
        >
          <Plus size={14} /> New agent
        </button>
      )}

      {form !== null && (
        <div className="space-y-3 rounded-md border border-border bg-bg-primary p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block text-text-secondary">Name</span>
              <input
                className={INPUT_CLASS}
                value={form.name}
                onChange={(event) => updateForm({ name: event.target.value })}
                placeholder="Release Captain"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-text-secondary">Colour</span>
              <input
                type="color"
                className="h-9 w-full cursor-pointer rounded-md border border-border bg-bg-primary"
                value={form.colour}
                onChange={(event) => updateForm({ colour: event.target.value })}
              />
            </label>
          </div>
          <label className="block text-sm">
            <span className="mb-1 block text-text-secondary">Description (optional)</span>
            <input
              className={INPUT_CLASS}
              value={form.description}
              onChange={(event) => updateForm({ description: event.target.value })}
              placeholder="Runs release checklists"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-text-secondary">System prompt</span>
            <textarea
              className={`${INPUT_CLASS} min-h-28 font-mono`}
              value={form.promptBody}
              onChange={(event) => updateForm({ promptBody: event.target.value })}
              placeholder={
                'You are a release captain for {{repoName}}.\n\nVariables: {{repoName}}, {{primaryLanguage}}, {{architectureDescription}}, {{conventions}}, {{moduleSummaries}}, {{workItems}}'
              }
            />
          </label>
          <fieldset className="flex flex-wrap gap-4 text-sm">
            <legend className="sr-only">Capabilities</legend>
            {(
              [
                ['canReadFiles', 'Read files'],
                ['canWriteFiles', 'Write files'],
                ['canRunCommands', 'Run commands'],
              ] as const
            ).map(([key, label]) => (
              <label
                key={key}
                className="flex cursor-pointer items-center gap-2 text-text-secondary"
              >
                <input
                  type="checkbox"
                  checked={form[key]}
                  onChange={(event) => updateForm({ [key]: event.target.checked })}
                  className="h-4 w-4 accent-accent"
                />
                {label}
              </label>
            ))}
          </fieldset>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving || form.name.trim() === '' || form.promptBody.trim() === ''}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent/90 disabled:opacity-50"
            >
              {saving ? 'Saving…' : editingId ? 'Save agent' : 'Create agent'}
            </button>
            <button
              type="button"
              onClick={() => {
                setForm(null);
                setEditingId(null);
                setError(null);
              }}
              className="rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error !== null && <p className="text-sm text-error">{error}</p>}
    </div>
  );
}

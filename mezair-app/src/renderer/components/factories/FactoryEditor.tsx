import {
  Check,
  CircleAlert,
  GitMerge,
  Lock,
  Plus,
  RefreshCw,
  Sparkles,
  TriangleAlert,
  UserRoundCheck,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  factoryWorkflowDrift,
  factoryWorkflowIssues,
  type FactoryDefinition,
  type FactoryDefinitionInput,
  type FactoryOrganizationMember,
  type FactoryOrganizationOption,
  type FactoryPreview,
  type FactoryRole,
} from '../../../shared/factories';
import type { RepoInfo, WorkflowTemplate } from '../../../shared/types';
import { Button } from '../ui/Button';
import { SegmentedControl } from '../ui/SegmentedControl';
import { cx } from '../ui/cx';
import { DRAFT_EXAMPLES, withAccess } from './factory-definition';
import {
  LIMIT_RANGES,
  definitionIssues,
  normalizeDefinition,
  type DefinitionIssue,
} from './factory-line';
import { FactoryAuthority } from './FactoryAuthority';
import { PinnedGraph } from './FactoryDefinitionPanel';
import { Field, Mono, Notice, inputClass } from './FactoryPrimitives';

type Update = (update: (current: FactoryDefinitionInput) => FactoryDefinitionInput) => void;

function EditorStation({
  id,
  title,
  description,
  issues,
  last = false,
  children,
}: {
  id: string;
  title: string;
  description: string;
  issues: DefinitionIssue[];
  last?: boolean;
  children: ReactNode;
}) {
  const state = issues.length ? 'attention' : 'passed';
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="relative grid grid-cols-[28px_minmax(0,1fr)] gap-x-4"
    >
      <div className="relative flex justify-center">
        <span className="factory-line-marker relative z-10 mt-0.5" data-mark={state}>
          {issues.length ? (
            <TriangleAlert size={10} strokeWidth={2.5} aria-hidden="true" />
          ) : (
            <Check size={10} strokeWidth={3} aria-hidden="true" className="text-bg-primary" />
          )}
        </span>
        {!last && (
          <span
            aria-hidden="true"
            className="absolute top-6 bottom-0 left-1/2 w-px -translate-x-1/2 bg-border-subtle"
          />
        )}
      </div>
      <div className={cx('min-w-0', !last && 'pb-9')}>
        <h3 id={`${id}-title`} className="text-sm font-semibold text-text-primary">
          {title}
        </h3>
        <p className="mt-0.5 text-xs leading-5 text-text-tertiary">{description}</p>
        {issues.length > 0 && (
          <ul className="mt-2 space-y-1">
            {issues.map((issue) => (
              <li key={issue.message} className="flex items-start gap-1.5 text-xs text-warning">
                <CircleAlert size={12} aria-hidden="true" className="mt-0.5 shrink-0" />
                {issue.message}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 space-y-4">{children}</div>
      </div>
    </section>
  );
}

function CommandRows({
  label,
  values,
  placeholder,
  addLabel,
  onChange,
}: {
  label: string;
  values: string[];
  placeholder: string;
  addLabel: string;
  onChange: (values: string[]) => void;
}) {
  const rows = values.length ? values : [''];
  return (
    <div className="space-y-2" role="group" aria-label={label}>
      {rows.map((value, index) => (
        <div key={index} className="flex items-center gap-2">
          <input
            aria-label={`${label} ${index + 1}`}
            className={inputClass('font-mono text-xs')}
            value={value}
            placeholder={placeholder}
            spellCheck={false}
            onChange={(event) =>
              onChange(
                rows.map((item, position) => (position === index ? event.target.value : item)),
              )
            }
          />
          <button
            type="button"
            aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
            disabled={rows.length === 1 && !value}
            className="rounded-md p-1.5 text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary disabled:invisible"
            onClick={() => onChange(rows.filter((_, position) => position !== index))}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      ))}
      <Button variant="ghost" size="sm" onClick={() => onChange([...rows, ''])}>
        <Plus size={13} aria-hidden="true" />
        {addLabel}
      </Button>
    </div>
  );
}

function CriteriaRows({
  draft,
  onDefinition,
}: {
  draft: FactoryDefinitionInput;
  onDefinition: Update;
}) {
  const count = Math.max(draft.criteria.length, draft.checks.length, 1);
  const rows = Array.from({ length: count }, (_, index) => ({
    criterion: draft.criteria[index] ?? '',
    check: draft.checks[index] ?? '',
  }));
  const write = (next: Array<{ criterion: string; check: string }>) =>
    onDefinition((current) => ({
      ...current,
      criteria: next.map((row) => row.criterion),
      checks: next.map((row) => row.check),
    }));
  return (
    <div className="space-y-2">
      <div className="hidden grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_28px] gap-2 text-xs text-text-tertiary sm:grid">
        <span>Criterion</span>
        <span>Proved by</span>
      </div>
      <ol className="space-y-2">
        {rows.map((row, index) => (
          <li
            key={index}
            className="grid grid-cols-[minmax(0,1fr)_28px] gap-2 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_28px]"
          >
            <input
              aria-label={`Criterion ${index + 1}`}
              className={inputClass()}
              placeholder="What must be true"
              value={row.criterion}
              onChange={(event) =>
                write(
                  rows.map((item, position) =>
                    position === index ? { ...item, criterion: event.target.value } : item,
                  ),
                )
              }
            />
            <input
              aria-label={`Check command for criterion ${index + 1}`}
              className={inputClass('order-3 col-span-1 font-mono text-xs sm:order-none')}
              placeholder="pnpm test"
              spellCheck={false}
              value={row.check}
              onChange={(event) =>
                write(
                  rows.map((item, position) =>
                    position === index ? { ...item, check: event.target.value } : item,
                  ),
                )
              }
            />
            <button
              type="button"
              aria-label={`Remove criterion ${index + 1}`}
              disabled={rows.length === 1 && !row.criterion && !row.check}
              className="grid place-items-center rounded-md text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary disabled:invisible"
              onClick={() => write(rows.filter((_, position) => position !== index))}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ol>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => write([...rows, { criterion: '', check: '' }])}
      >
        <Plus size={13} aria-hidden="true" />
        Add criterion
      </Button>
    </div>
  );
}

function WorkflowPicker({
  templates,
  value,
  pinned,
  onChange,
}: {
  templates: WorkflowTemplate[];
  value: string;
  pinned: FactoryDefinition | null;
  onChange: (id: string) => void;
}) {
  const options = useMemo(
    () =>
      templates
        .map((template) => ({ template, issues: factoryWorkflowIssues(template) }))
        .sort((a, b) => Number(a.issues.length > 0) - Number(b.issues.length > 0)),
    [templates],
  );
  const pinnedMissing =
    pinned && !templates.some((template) => template.id === pinned.definition.workflowTemplateId);
  return (
    <div role="radiogroup" aria-label="Workflow graph" className="space-y-1.5">
      {pinnedMissing && value === pinned.definition.workflowTemplateId && (
        <div className="flex items-start gap-3 rounded-xl border border-accent/40 bg-accent/[0.06] px-3 py-2.5">
          <span
            className="mt-1 h-3.5 w-3.5 shrink-0 rounded-full border-4 border-accent"
            aria-hidden="true"
          />
          <span className="min-w-0 text-sm text-text-primary">
            {pinned.workflow.name}
            <span className="block text-xs text-text-tertiary">
              Pinned copy. Its saved workflow was deleted, so this revision keeps the pinned graph.
            </span>
          </span>
        </div>
      )}
      {options.map(({ template, issues }) => {
        const selected = template.id === value;
        const disabled = issues.length > 0;
        const models = [...new Set(template.nodes.map((node) => node.model))];
        return (
          <label
            key={template.id}
            className={cx(
              'flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors',
              selected
                ? 'border-accent/45 bg-accent/[0.06]'
                : 'border-border-subtle hover:border-border hover:bg-bg-secondary',
              disabled &&
                'cursor-not-allowed opacity-70 hover:border-border-subtle hover:bg-transparent',
            )}
          >
            <input
              type="radio"
              name="factory-workflow"
              className="mt-1 accent-[var(--color-accent)]"
              checked={selected}
              disabled={disabled && !selected}
              onChange={() => onChange(template.id)}
            />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-sm font-medium text-text-primary">{template.name}</span>
                <span className="text-xs text-text-tertiary">
                  {template.nodes.map((node) => node.name).join(' → ') || 'No steps'}
                </span>
                {pinned?.definition.workflowTemplateId === template.id && (
                  <span className="text-xs text-text-secondary">Pinned now</span>
                )}
              </span>
              {disabled ? (
                <span className="mt-0.5 flex items-start gap-1.5 text-xs text-text-tertiary">
                  <Lock size={12} aria-hidden="true" className="mt-0.5 shrink-0" />
                  {issues[0]}
                </span>
              ) : (
                models.length > 0 && (
                  <span className="mt-0.5 block text-xs text-text-tertiary">
                    {models.join(', ')}
                  </span>
                )
              )}
            </span>
          </label>
        );
      })}
      {!options.length && (
        <p className="text-xs text-text-tertiary">
          No saved workflows yet. Create one in Workflows, then come back to pin it.
        </p>
      )}
    </div>
  );
}

function MembersEditor({
  access,
  onDefinition,
}: {
  access: Extract<FactoryDefinitionInput['access'], { kind: 'organization' }>;
  onDefinition: Update;
}) {
  const [members, setMembers] = useState<FactoryOrganizationMember[]>([]);
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<FactoryRole>('viewer');
  useEffect(() => {
    if (!access.organizationId) {
      setMembers([]);
      return;
    }
    let current = true;
    window.mezair.factories
      .listOrganizationMembers(access.organizationId)
      .then((items) => {
        if (current) setMembers(items);
      })
      .catch(() => {
        if (current) setMembers([]);
      });
    return () => {
      current = false;
    };
  }, [access.organizationId]);
  const setAccessMembers = (next: typeof access.members) =>
    onDefinition((current) => ({
      ...current,
      access:
        current.access.kind === 'organization'
          ? { ...current.access, members: next }
          : current.access,
    }));
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs font-medium text-text-secondary">
        <UserRoundCheck size={14} aria-hidden="true" />
        Member roles
      </div>
      <p className="max-w-prose text-xs leading-5 text-text-tertiary">
        Viewers follow runs, operators can pause, retry and pick them up, and owners edit and
        activate. New recipients stay pending until they enrol an encryption key. Organization admin
        authority is verified by the service and cannot be assigned here.
      </p>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_150px_auto]">
        <select
          className={inputClass()}
          aria-label="Organization member"
          value={userId}
          onChange={(event) => setUserId(event.target.value)}
        >
          <option value="">Choose an organization member</option>
          {members
            .filter((member) => !access.members.some((current) => current.userId === member.userId))
            .map((member) => (
              <option key={member.userId} value={member.userId}>
                {member.userId} ({member.role})
              </option>
            ))}
        </select>
        <select
          className={inputClass()}
          aria-label="Factory role"
          value={role}
          onChange={(event) => setRole(event.target.value as FactoryRole)}
        >
          <option value="viewer">Viewer</option>
          <option value="operator">Operator</option>
          <option value="owner">Owner</option>
        </select>
        <Button
          variant="secondary"
          disabled={!userId || !access.organizationId}
          onClick={() => {
            setAccessMembers([
              ...access.members.filter((member) => member.userId !== userId),
              { userId, role },
            ]);
            setUserId('');
          }}
        >
          Add member
        </Button>
      </div>
      {access.members.length > 0 && (
        <ul className="divide-y divide-border-subtle rounded-xl border border-border-subtle">
          {access.members.map((member) => (
            <li key={member.userId} className="flex items-center gap-3 px-3 py-2 text-xs">
              <span className="min-w-0 flex-1 truncate text-text-primary">{member.userId}</span>
              <select
                aria-label={`Role for ${member.userId}`}
                className="rounded-lg border border-border bg-bg-primary px-2 py-1 text-text-secondary"
                value={member.role}
                onChange={(event) =>
                  setAccessMembers(
                    access.members.map((item) =>
                      item.userId === member.userId
                        ? { ...item, role: event.target.value as FactoryRole }
                        : item,
                    ),
                  )
                }
              >
                <option value="viewer">Viewer</option>
                <option value="operator">Operator</option>
                <option value="owner">Owner</option>
              </select>
              <button
                type="button"
                className="rounded-md px-1.5 py-1 text-text-tertiary hover:bg-bg-tertiary hover:text-error"
                onClick={() =>
                  setAccessMembers(access.members.filter((item) => item.userId !== member.userId))
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function FactoryEditor({
  draft,
  editing,
  templates,
  repos,
  organizations,
  preview,
  busy,
  repinWorkflow,
  request,
  drafting,
  draftedFromRequest,
  onRequest,
  onDraftFromRequest,
  onDefinition,
  onRepo,
  onRepin,
  onPreview,
  onSave,
  onCancel,
}: {
  draft: FactoryDefinitionInput;
  editing: FactoryDefinition | null;
  templates: WorkflowTemplate[];
  repos: RepoInfo[];
  organizations: FactoryOrganizationOption[];
  preview: FactoryPreview | null;
  busy: boolean;
  repinWorkflow: boolean;
  request: string;
  drafting: boolean;
  draftedFromRequest: boolean;
  onRequest: (value: string) => void;
  onDraftFromRequest: () => void;
  onDefinition: Update;
  onRepo: (repoId: string) => void;
  onRepin: (value: boolean) => void;
  onPreview: (definition: FactoryDefinitionInput) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const reviewRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (preview) reviewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [preview]);

  const selectedTemplate = templates.find((template) => template.id === draft.workflowTemplateId);
  const keepsPinned =
    editing !== null && draft.workflowTemplateId === editing.definition.workflowTemplateId;
  const drift = keepsPinned ? factoryWorkflowDrift(editing.workflow, selectedTemplate) : null;
  const workflowIssues =
    keepsPinned && !(repinWorkflow && drift === 'changed')
      ? []
      : selectedTemplate
        ? factoryWorkflowIssues(selectedTemplate)
        : [];
  const normalized = useMemo(() => normalizeDefinition(draft), [draft]);
  const issues = definitionIssues(
    normalized,
    keepsPinned && drift === 'missing' ? [] : workflowIssues,
  );
  const issuesFor = (...fields: DefinitionIssue['field'][]) =>
    issues.filter((issue) => fields.includes(issue.field));
  const reviewWorkflow =
    keepsPinned && !(repinWorkflow && drift === 'changed')
      ? editing.workflow
      : (selectedTemplate ?? null);
  const orgAccess = draft.access.kind === 'organization' ? draft.access : null;
  const sourceLocked = editing !== null;
  const reserved = normalized.checks.length + normalized.postMergeChecks.length + 1;

  return (
    <div className="mx-auto w-full max-w-3xl px-6 pt-6 pb-28">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">
            {editing ? `Revise ${editing.definition.name}` : 'New factory'}
          </h2>
          <p className="mt-1 max-w-prose text-sm leading-6 text-text-secondary">
            {editing
              ? `Saving creates revision ${editing.revision + 1}. Runs already in progress keep the revision they started with.`
              : 'Describe the issue-to-merge process, then check each station. Nothing runs until you review and activate it.'}
          </p>
        </div>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </header>

      {!editing && (
        <section aria-label="Describe the factory" className="mb-10">
          <label htmlFor="factory-request" className="text-sm font-medium text-text-primary">
            Describe it in your own words
          </label>
          <div className="mt-2 rounded-2xl border border-border bg-bg-tertiary transition-colors focus-within:border-accent/60">
            <textarea
              id="factory-request"
              autoFocus
              value={request}
              onChange={(event) => onRequest(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && request.trim()) {
                  event.preventDefault();
                  onDraftFromRequest();
                }
              }}
              rows={3}
              placeholder="For new ready-for-agent issues, implement the fix, run the tests and open a draft PR. Repair CI at most twice, then ask me to merge."
              className="factory-field block min-h-24 w-full resize-y bg-transparent px-4 pt-3.5 pb-2 text-sm leading-6 text-text-primary outline-none placeholder:text-text-muted"
            />
            <div className="flex flex-wrap items-center gap-2 px-3 pb-3">
              {DRAFT_EXAMPLES.map((example) => (
                <button
                  key={example.label}
                  type="button"
                  className="rounded-full border border-border-subtle px-2.5 py-1 text-xs text-text-secondary hover:border-border hover:text-text-primary"
                  onClick={() => onRequest(example.request)}
                >
                  {example.label}
                </button>
              ))}
              <Button
                className="ml-auto"
                size="sm"
                disabled={drafting || !request.trim()}
                onClick={onDraftFromRequest}
              >
                <Sparkles size={13} aria-hidden="true" />
                {drafting ? 'Drafting…' : 'Draft definition'}
              </Button>
            </div>
          </div>
          <p className="mt-2 text-xs text-text-tertiary">
            {draftedFromRequest
              ? 'Drafted from your description. Every station below is editable; check them before review.'
              : 'Or fill in the stations below yourself.'}
          </p>
        </section>
      )}

      <div
        aria-busy={drafting}
        className={cx(drafting && 'pointer-events-none opacity-60 transition-opacity')}
      >
        <EditorStation
          id="station-intake"
          title="Intake"
          description="Which issues start a run."
          issues={issuesFor('name', 'repo', 'label', 'baseBranch')}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Factory name">
              <input
                className={inputClass()}
                value={draft.name}
                onChange={(event) =>
                  onDefinition((current) => ({ ...current, name: event.target.value }))
                }
              />
            </Field>
            <Field
              label="Repository"
              group={sourceLocked}
              hint={
                sourceLocked
                  ? 'The source repository is fixed for a factory. Create a new factory to watch another.'
                  : undefined
              }
            >
              {sourceLocked ? (
                <div
                  className={inputClass('flex items-center gap-2 text-text-secondary')}
                  aria-readonly="true"
                >
                  <Lock size={13} aria-hidden="true" className="shrink-0 text-text-tertiary" />
                  <Mono>
                    {draft.github.owner}/{draft.github.repo}
                  </Mono>
                </div>
              ) : (
                <select
                  className={inputClass()}
                  value={draft.repoId}
                  onChange={(event) => onRepo(event.target.value)}
                >
                  <option value="">Choose a GitHub repository</option>
                  {repos.map((repo) => (
                    <option key={repo.id} value={repo.id}>
                      {repo.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Issue label" hint="Only open issues carrying this label are eligible.">
              <input
                className={inputClass('font-mono text-xs')}
                value={draft.github.label}
                spellCheck={false}
                onChange={(event) =>
                  onDefinition((current) => ({
                    ...current,
                    github: { ...current.github, label: event.target.value },
                  }))
                }
              />
            </Field>
            <Field label="Base branch">
              <input
                className={inputClass('font-mono text-xs')}
                value={draft.github.baseBranch}
                spellCheck={false}
                onChange={(event) =>
                  onDefinition((current) => ({
                    ...current,
                    github: { ...current.github, baseBranch: event.target.value },
                  }))
                }
              />
            </Field>
          </div>
        </EditorStation>

        <EditorStation
          id="station-build"
          title="Build"
          description="The workflow graph is copied into the revision when you save, so later edits never change running work."
          issues={issuesFor('workflow')}
        >
          {editing?.remote ? (
            <>
              <PinnedGraph workflow={editing.workflow} />
              <p className="text-xs text-text-tertiary">
                Shared revisions keep the pinned graph. Change it on the executing device.
              </p>
            </>
          ) : (
            <WorkflowPicker
              templates={templates}
              value={draft.workflowTemplateId}
              pinned={editing}
              onChange={(id) => onDefinition((current) => ({ ...current, workflowTemplateId: id }))}
            />
          )}
          {!editing?.remote && keepsPinned && drift === 'changed' && (
            <Notice tone="info" icon={RefreshCw}>
              <label className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  className="mt-1 accent-[var(--color-accent)]"
                  checked={repinWorkflow}
                  onChange={(event) => onRepin(event.target.checked)}
                />
                <span>
                  <span className="font-medium text-text-primary">
                    Pin the current version of {selectedTemplate?.name}
                  </span>
                  <span className="block">
                    The saved workflow changed after revision {editing.revision} pinned it. Leave
                    this off to keep the pinned graph.
                  </span>
                </span>
              </label>
            </Notice>
          )}
        </EditorStation>

        <EditorStation
          id="station-verify"
          title="Verify"
          description="Each criterion is bound to the command on its row. The run publishes only when every command passes on the produced commit."
          issues={issuesFor('criteria')}
        >
          <CriteriaRows draft={draft} onDefinition={onDefinition} />
          <p className="max-w-prose text-xs leading-5 text-text-tertiary">
            Subjective criteria still need human review. Keep commands exact; they run with standing
            approval.
          </p>
        </EditorStation>

        <EditorStation
          id="station-publish"
          title="PR"
          description="Publication pushes the factory branch and opens or updates its pull request. It never grants merge."
          issues={[]}
        >
          <div className="space-y-2.5 text-sm">
            <label className="flex items-start gap-2.5 text-text-primary">
              <input
                type="checkbox"
                className="mt-1 accent-[var(--color-accent)]"
                checked={draft.publication.enabled}
                disabled={draft.merge.mode === 'auto-merge'}
                onChange={(event) =>
                  onDefinition((current) => ({
                    ...current,
                    publication: { ...current.publication, enabled: event.target.checked },
                  }))
                }
              />
              <span>
                Publish verified branches and pull requests
                <span className="block text-xs text-text-tertiary">
                  {draft.merge.mode === 'auto-merge'
                    ? 'Required while auto-merge is on.'
                    : 'Required to activate the factory.'}
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2.5 text-text-primary">
              <input
                type="checkbox"
                className="mt-1 accent-[var(--color-accent)]"
                checked={draft.publication.draft}
                disabled={!draft.publication.enabled}
                onChange={(event) =>
                  onDefinition((current) => ({
                    ...current,
                    publication: { ...current.publication, draft: event.target.checked },
                  }))
                }
              />
              Open pull requests as drafts
            </label>
          </div>
        </EditorStation>

        <EditorStation
          id="station-merge"
          title="Merge"
          description="Who may merge, and which gates must pass at the current head first."
          issues={issuesFor('merge')}
        >
          <div role="radiogroup" aria-label="Merge authority" className="grid gap-2 sm:grid-cols-2">
            {(
              [
                {
                  mode: 'human-approved',
                  title: 'I approve each merge',
                  body: 'A person approves the exact verified head every time.',
                },
                {
                  mode: 'auto-merge',
                  title: 'Auto-merge when gates pass',
                  body: 'Standing authority, limited to this repository, branch and method.',
                },
              ] as const
            ).map((option) => {
              const selected = draft.merge.mode === option.mode;
              const disabled = option.mode === 'auto-merge' && !draft.publication.enabled;
              return (
                <label
                  key={option.mode}
                  className={cx(
                    'flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-3 transition-colors',
                    selected
                      ? option.mode === 'auto-merge'
                        ? 'border-warning/50 bg-warning/[0.06]'
                        : 'border-accent/45 bg-accent/[0.06]'
                      : 'border-border-subtle hover:border-border hover:bg-bg-secondary',
                    disabled && 'cursor-not-allowed opacity-60',
                  )}
                >
                  <input
                    type="radio"
                    name="factory-merge-mode"
                    className="mt-1 accent-[var(--color-accent)]"
                    checked={selected}
                    disabled={disabled}
                    onChange={() =>
                      onDefinition((current) => ({
                        ...current,
                        merge: { ...current.merge, mode: option.mode },
                      }))
                    }
                  />
                  <span>
                    <span className="block text-sm font-medium text-text-primary">
                      {option.title}
                    </span>
                    <span className="mt-0.5 block text-xs leading-5 text-text-tertiary">
                      {option.body}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          <Field label="Merge method" group>
            <SegmentedControl
              label="Merge method"
              value={draft.merge.method}
              options={[
                { value: 'squash', label: 'Squash' },
                { value: 'merge', label: 'Merge commit' },
                { value: 'rebase', label: 'Rebase' },
              ]}
              onChange={(method) =>
                onDefinition((current) => ({ ...current, merge: { ...current.merge, method } }))
              }
            />
          </Field>
          <Field
            label="Required CI checks"
            group
            hint="Exact GitHub check names that must pass at the current head."
          >
            <CommandRows
              label="Required check"
              values={draft.merge.requiredChecks}
              placeholder="ci / test"
              addLabel="Add required check"
              onChange={(requiredChecks) =>
                onDefinition((current) => ({
                  ...current,
                  merge: { ...current.merge, requiredChecks },
                }))
              }
            />
          </Field>
          <label className="flex items-start gap-2.5 text-sm text-text-primary">
            <input
              type="checkbox"
              className="mt-1 accent-[var(--color-accent)]"
              checked={draft.merge.requireApproval}
              onChange={(event) =>
                onDefinition((current) => ({
                  ...current,
                  merge: { ...current.merge, requireApproval: event.target.checked },
                }))
              }
            />
            <span>
              Require a human review approval
              <span className="block text-xs text-text-tertiary">
                A factory-authored review never satisfies a required approval.
              </span>
            </span>
          </label>
        </EditorStation>

        <EditorStation
          id="station-confirm"
          title="Confirm"
          description="Commands that run on the merge commit. A run is done only after they pass."
          issues={issuesFor('postMerge')}
        >
          <CommandRows
            label="Post-merge check"
            values={draft.postMergeChecks}
            placeholder="pnpm test"
            addLabel="Add post-merge check"
            onChange={(postMergeChecks) =>
              onDefinition((current) => ({ ...current, postMergeChecks }))
            }
          />
        </EditorStation>

        <EditorStation
          id="station-limits"
          title="Limits"
          description="Observed per issue. Workers stop as soon as a budget runs out."
          issues={issuesFor('limits')}
        >
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {(Object.keys(LIMIT_RANGES) as Array<keyof typeof LIMIT_RANGES>).map((key) => {
              const range = LIMIT_RANGES[key];
              const value = draft.limits[key];
              return (
                <Field
                  key={key}
                  label={range.label}
                  hint={
                    key === 'maxCommands' ? `At least ${reserved}` : `${range.min} to ${range.max}`
                  }
                >
                  <input
                    className={inputClass('tabular-nums')}
                    type="number"
                    inputMode="numeric"
                    min={range.min}
                    max={range.max}
                    value={Number.isFinite(value) ? value : ''}
                    onChange={(event) => {
                      const next =
                        event.target.value === ''
                          ? Number.NaN
                          : Math.trunc(Number(event.target.value));
                      onDefinition((current) => ({
                        ...current,
                        limits: { ...current.limits, [key]: next },
                      }));
                    }}
                  />
                </Field>
              );
            })}
          </div>
          <p className="text-xs text-text-tertiary">
            Command counts are observed, not a pre-execution allowlist. There is no spend ceiling.
          </p>
        </EditorStation>

        <EditorStation
          id="station-audience"
          title="Audience"
          description="Who can discover the factory and follow its runs. It never grants repository access or credentials."
          issues={issuesFor('access')}
          last
        >
          <SegmentedControl
            label="Factory access"
            size="md"
            value={draft.access.kind}
            options={[
              { value: 'private', label: 'Only me' },
              {
                value: 'organization',
                label: 'Share with organization',
                disabled: !organizations.length && draft.access.kind !== 'organization',
                title: organizations.length
                  ? undefined
                  : 'Join an organization with Sync to share factories.',
              },
            ]}
            onChange={(kind) =>
              onDefinition((current) => ({ ...current, access: withAccess(current.access, kind) }))
            }
          />
          {editing?.definition.access.kind === 'organization' &&
            draft.access.kind === 'private' && (
              <Notice tone="warning" icon={TriangleAlert}>
                A shared factory cannot be made private in a revision.
              </Notice>
            )}
          {orgAccess && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Organization">
                  <select
                    className={inputClass()}
                    value={orgAccess.organizationId}
                    onChange={(event) =>
                      onDefinition((current) => ({
                        ...current,
                        access:
                          current.access.kind === 'organization'
                            ? { ...current.access, organizationId: event.target.value, members: [] }
                            : current.access,
                      }))
                    }
                  >
                    <option value="">Choose an organization</option>
                    {organizations.map((organization) => (
                      <option key={organization.id} value={organization.id}>
                        {organization.id} ({organization.role})
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Visibility">
                  <select
                    className={inputClass()}
                    value={orgAccess.visibility}
                    onChange={(event) =>
                      onDefinition((current) => ({
                        ...current,
                        access:
                          current.access.kind === 'organization'
                            ? {
                                ...current.access,
                                visibility: event.target.value as
                                  'organization' | 'team' | 'restricted',
                              }
                            : current.access,
                      }))
                    }
                  >
                    <option value="team">A GitHub team</option>
                    <option value="organization">Everyone in the organization</option>
                    <option value="restricted">Named members only</option>
                  </select>
                </Field>
                {orgAccess.visibility === 'team' && (
                  <Field
                    label="GitHub team slug"
                    hint="Membership is checked on every read and control."
                  >
                    <input
                      className={inputClass('font-mono text-xs')}
                      value={orgAccess.teamId ?? ''}
                      spellCheck={false}
                      onChange={(event) =>
                        onDefinition((current) => ({
                          ...current,
                          access:
                            current.access.kind === 'organization'
                              ? { ...current.access, teamId: event.target.value }
                              : current.access,
                        }))
                      }
                    />
                  </Field>
                )}
              </div>
              <MembersEditor access={orgAccess} onDefinition={onDefinition} />
            </>
          )}
        </EditorStation>
      </div>

      <div ref={reviewRef} className="mt-10 scroll-mt-6">
        {preview && (
          <FactoryAuthority
            preview={preview}
            workflow={reviewWorkflow}
            mode="save"
            revision={(editing?.revision ?? 0) + 1}
            repinned={keepsPinned && repinWorkflow && drift === 'changed'}
          >
            <Button variant="ghost" onClick={onCancel}>
              Discard
            </Button>
            <Button disabled={busy} onClick={onSave}>
              <Check size={14} aria-hidden="true" />
              {busy
                ? 'Saving…'
                : editing
                  ? `Save revision ${editing.revision + 1}`
                  : 'Save inactive draft'}
            </Button>
          </FactoryAuthority>
        )}
      </div>

      {!preview && (
        <div className="sticky bottom-0 z-20 -mx-6 mt-10 border-t border-border-subtle bg-bg-primary px-6 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <p
              className={cx(
                'mr-auto flex items-center gap-2 text-xs',
                issues.length ? 'text-warning' : 'text-text-secondary',
              )}
            >
              {issues.length ? (
                <>
                  <CircleAlert size={14} aria-hidden="true" />
                  {issues.length === 1
                    ? issues[0].message
                    : `${issues.length} things to fix before review.`}
                </>
              ) : (
                <>
                  <GitMerge size={14} aria-hidden="true" className="text-text-tertiary" />
                  Ready to review what this factory may do.
                </>
              )}
            </p>
            <Button
              disabled={busy || drafting || issues.length > 0}
              onClick={() => onPreview(normalized)}
            >
              {busy ? 'Checking…' : 'Review definition'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

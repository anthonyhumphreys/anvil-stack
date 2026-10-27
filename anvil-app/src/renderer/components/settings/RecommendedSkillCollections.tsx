import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Download,
  ExternalLink,
  Loader2,
  Plus,
  Settings2,
  Trash2,
} from 'lucide-react';
import type { CodexRegistryActionResult } from '../../../shared/types';
import type {
  OrganizationSkillRecommendations,
  SkillCollectionInspection,
  SkillRecommendationCatalog,
  SkillRecommendationSelection,
  SkillRecommendationSource,
} from '../../../shared/skill-recommendations';
import { parseSkillRecommendationSources } from '../../../../cloud/contract/skill-recommendations';
import { createSkillRecommendationSaver } from './skill-recommendations-save';

const secondaryButton =
  'inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50';
const fieldClass =
  'w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-2 focus:outline-accent disabled:opacity-50';
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Try again.';

export function RecommendedSkillCollections({
  refreshKey,
  onAction,
}: {
  refreshKey?: string;
  onAction: (action: CodexRegistryActionResult) => void;
}) {
  const [catalog, setCatalog] = useState<SkillRecommendationCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [installing, setInstalling] = useState<string | null>(null);
  const [editingOrg, setEditingOrg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.anvil.codexRegistry
      .recommendations()
      .then((result) => {
        if (!cancelled) {
          setCatalog(result);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(message(err));
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey, reload]);

  if (!catalog)
    return error ? (
      <div role="alert" className="space-y-3 text-sm text-error">
        <p>{error}</p>
        <button className={secondaryButton} onClick={() => setReload((value) => value + 1)}>
          Try again
        </button>
      </div>
    ) : (
      <p role="status" className="flex items-center gap-2 py-8 text-sm text-text-secondary">
        <Loader2 size={16} className="animate-spin" />
        Loading recommended collections…
      </p>
    );

  const selection = (
    source: SkillRecommendationSource,
    organizationId?: string,
  ): SkillRecommendationSelection => ({
    sourceId: source.id,
    organizationId,
    scopeKey: catalog.scopeKey,
  });

  const collections = (sources: SkillRecommendationSource[], organizationId?: string) => (
    <div className="divide-y divide-border-subtle border-y border-border-subtle">
      {sources.map((source) => {
        const key = `${catalog.scopeKey}:${organizationId ?? 'anvil'}:${source.id}`;
        return (
          <CollectionRow
            key={key}
            source={source}
            selection={selection(source, organizationId)}
            installing={installing === key}
            disabled={installing !== null}
            onInstall={async (skillName) => {
              setInstalling(key);
              try {
                const result = await window.anvil.codexRegistry.installCollection({
                  ...selection(source, organizationId),
                  skillName,
                });
                onAction(result);
                return result;
              } catch (err) {
                const result = { success: false, command: '', error: message(err) };
                onAction(result);
                return result;
              } finally {
                setInstalling(null);
              }
            }}
          />
        );
      })}
    </div>
  );

  return (
    <div className="space-y-8">
      <section aria-labelledby="recommended-heading">
        <h3 id="recommended-heading" className="text-base font-semibold text-text-primary">
          Collections from people we trust
        </h3>
        <p className="mb-5 mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
          Install a creator’s skills together, or explore the collection and pick your own. Skills
          are added to your Codex user library.
        </p>
        {collections(catalog.sources)}
        {!catalog.sources.length && (
          <p className="py-5 text-sm text-text-secondary">
            No Anvil collections are configured yet.
          </p>
        )}
      </section>

      {error && (
        <p role="alert" className="text-sm text-error">
          Could not refresh collections: {error}
        </p>
      )}
      {catalog.warning && (
        <div role="status" className="flex flex-wrap items-center gap-2 text-sm text-warning">
          <AlertTriangle size={15} />
          <span>{catalog.warning}</span>
          <button className={secondaryButton} onClick={() => setReload((value) => value + 1)}>
            Retry
          </button>
        </div>
      )}

      {catalog.organizations.map((org) => (
        <section key={org.organizationId} aria-label={`${org.name} recommended skills`}>
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-text-primary">
                Recommended by {org.name}
              </h3>
              <p className="mt-1 text-sm text-text-secondary">
                Collections chosen by your organisation.
              </p>
            </div>
            {org.canEdit && (
              <button
                className={secondaryButton}
                aria-expanded={editingOrg === org.organizationId}
                onClick={() =>
                  setEditingOrg(editingOrg === org.organizationId ? null : org.organizationId)
                }
              >
                <Settings2 size={14} />
                {editingOrg === org.organizationId
                  ? 'Close configuration'
                  : 'Configure collections'}
              </button>
            )}
          </div>
          {editingOrg === org.organizationId && catalog.scopeKey && (
            <OrganizationCollectionsEditor
              key={`${catalog.scopeKey}:${org.organizationId}`}
              org={org}
              scopeKey={catalog.scopeKey}
              onReload={() => {
                setEditingOrg(null);
                setCatalog(null);
                setError(null);
                setReload((value) => value + 1);
              }}
              onSaved={(sources, version) =>
                setCatalog((current) =>
                  current
                    ? {
                        ...current,
                        organizations: current.organizations.map((item) =>
                          item.organizationId === org.organizationId
                            ? { ...item, sources, version }
                            : item,
                        ),
                      }
                    : current,
                )
              }
            />
          )}
          {collections(org.sources, org.organizationId)}
          {!org.sources.length && (
            <p className="py-5 text-sm text-text-secondary">
              Your organisation hasn’t recommended any collections yet.
              {org.canEdit ? ' Add a trusted repository to get started.' : ''}
            </p>
          )}
        </section>
      ))}
      {!catalog.organizations.length && !catalog.warning && (
        <div className="text-sm text-text-secondary">
          <h3 className="font-medium text-text-primary">Your organisation’s recommendations</h3>
          <p className="mt-1">
            {catalog.scopeKey
              ? 'Collections will appear here when an organisation owner configures them.'
              : 'Sign in to Anvil Cloud to see collections chosen by your organisation.'}
          </p>
        </div>
      )}
    </div>
  );
}

function CollectionRow({
  source,
  selection,
  installing,
  disabled,
  onInstall,
}: {
  source: SkillRecommendationSource;
  selection: SkillRecommendationSelection;
  installing: boolean;
  disabled: boolean;
  onInstall: (skillName?: string) => Promise<CodexRegistryActionResult>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [inspection, setInspection] = useState<SkillCollectionInspection | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ success: boolean; text: string } | null>(null);
  const install = async (skillName?: string) => {
    setOutcome(null);
    const result = await onInstall(skillName);
    setOutcome({
      success: result.success,
      text: result.success
        ? `${skillName ?? source.name} installed.`
        : (result.error ?? 'Installation failed. Try again.'),
    });
  };
  const identity = JSON.stringify([selection, source]);
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    setLoading(true);
    setInspection(null);
    setError(null);
    window.anvil.codexRegistry
      .inspectCollection(selection)
      .then((result) => {
        if (!cancelled) setInspection(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(message(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // The serialized identity captures source revisions as well as account scope.
  }, [expanded, identity]);

  return (
    <article className="py-5">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="min-w-0 flex-1 basis-64">
          <h4 className="text-base font-semibold text-text-primary">{source.name}</h4>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
            {source.description}
          </p>
          <a
            href={`https://github.com/${source.repository}${source.path ? `/tree/${encodeURIComponent(source.ref ?? 'HEAD')}/${source.path}` : ''}`}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-sm text-xs text-text-secondary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-accent"
          >
            <span className="break-all">
              {source.repository}
              {source.path ? ` / ${source.path}` : ''}
            </span>
            <ExternalLink size={12} className="shrink-0" />
          </a>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            className={secondaryButton}
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? 'Hide skills' : 'Explore skills'}
            <ChevronDown size={14} className={expanded ? 'rotate-180' : ''} />
          </button>
          <button
            onClick={() => void install()}
            disabled={disabled}
            className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
          >
            {installing ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            {installing ? 'Installing…' : `Install ${source.name}`}
          </button>
        </div>
      </div>
      {outcome && (
        <p
          role={outcome.success ? 'status' : 'alert'}
          className={`mt-3 text-sm ${outcome.success ? 'text-success' : 'text-error'}`}
        >
          {outcome.text}
        </p>
      )}
      {expanded && (
        <div className="mt-5" aria-live="polite">
          {loading && (
            <p className="flex items-center gap-2 text-sm text-text-secondary">
              <Loader2 size={14} className="animate-spin" />
              Reading collection from GitHub…
            </p>
          )}
          {error && (
            <div role="alert" className="text-sm text-error">
              <p>{error}</p>
              <button
                className="mt-2 underline underline-offset-4"
                onClick={() => {
                  setExpanded(false);
                }}
              >
                Close and try again
              </button>
            </div>
          )}
          {inspection && (
            <>
              <p className="mb-2 text-xs text-text-secondary">
                {inspection.skills.length} skills · {source.ref ?? 'Default branch'}
              </p>
              <ul className="divide-y divide-border-subtle">
                {inspection.skills.map((skill) => (
                  <li key={skill.name} className="flex items-start justify-between gap-4 py-3">
                    <div className="min-w-0">
                      <a
                        href={skill.url}
                        target="_blank"
                        rel="noreferrer"
                        className="break-words text-sm font-medium text-text-primary underline-offset-4 hover:underline"
                      >
                        {skill.name}
                      </a>
                      <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
                        {skill.description}
                      </p>
                    </div>
                    <button
                      className={secondaryButton}
                      disabled={disabled}
                      onClick={() => void install(skill.name)}
                      aria-label={`Install ${skill.name}`}
                    >
                      Install
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </article>
  );
}

function OrganizationCollectionsEditor({
  org,
  scopeKey,
  onSaved,
  onReload,
}: {
  org: OrganizationSkillRecommendations;
  scopeKey: string;
  onSaved: (sources: SkillRecommendationSource[], version: number) => void;
  onReload: () => void;
}) {
  const [drafts, setDrafts] = useState(org.sources);
  const [status, setStatus] = useState(
    'Changes save when you leave a field. Members choose what to install.',
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const latestDrafts = useRef(org.sources);
  const pendingCount = useRef(0);
  const [saver] = useState(() =>
    createSkillRecommendationSaver(org.version, org.sources, (sources, expectedVersion) =>
      window.anvil.codexRegistry.saveRecommendations({
        organizationId: org.organizationId,
        scopeKey,
        expectedVersion,
        sources,
      }),
    ),
  );
  const changeDrafts = (next: SkillRecommendationSource[]) => {
    latestDrafts.current = next;
    setDrafts(next);
  };

  const save = async (next: SkillRecommendationSource[]) => {
    pendingCount.current += 1;
    setSaving(true);
    setError(null);
    try {
      const result = await saver.save(next);
      let unchanged = false;
      try {
        unchanged =
          JSON.stringify(parseSkillRecommendationSources(latestDrafts.current)) ===
          JSON.stringify(result.sources);
      } catch {
        /* An incomplete new collection remains a local draft. */
      }
      setStatus(unchanged ? 'Saved for your organisation' : 'Unsaved changes');
      onSaved(result.sources, result.version);
    } catch (err) {
      setError(
        `${message(err)} Your edits are still here. Reload shared collections to discard these edits and review the latest version.`,
      );
    } finally {
      pendingCount.current -= 1;
      setSaving(pendingCount.current > 0);
    }
  };
  const update = (index: number, field: keyof SkillRecommendationSource, value: string) => {
    changeDrafts(
      latestDrafts.current.map((item, i) =>
        i === index
          ? { ...item, [field]: value || (field === 'ref' || field === 'path' ? undefined : '') }
          : item,
      ),
    );
    setStatus('Unsaved changes');
  };

  return (
    <div className="mb-5 space-y-4 rounded-lg border border-border bg-bg-secondary p-4">
      <p className="text-sm text-text-secondary">
        Choose trusted GitHub repositories. Each repository becomes an installable collection for{' '}
        {org.name}.
      </p>
      {drafts.map((source, index) => (
        <div
          key={source.id}
          className="grid gap-3 border-b border-border-subtle pb-4 sm:grid-cols-2"
        >
          {(
            [
              ['name', 'Collection name', 'Theo’s skills'],
              ['repository', 'GitHub repository', 't3dotgg/tstack'],
              ['description', 'Description', 'What this collection helps with'],
              ['ref', 'Branch, tag or commit (optional)', 'Default branch'],
              ['path', 'Skills directory (optional)', 'skills'],
            ] as const
          ).map(([field, label, placeholder]) => (
            <label key={field} className="space-y-1 text-xs text-text-secondary">
              <span>{label}</span>
              <input
                className={fieldClass}
                value={source[field] ?? ''}
                placeholder={placeholder}
                onChange={(event) => update(index, field, event.target.value)}
                onBlur={() => void save(latestDrafts.current)}
              />
            </label>
          ))}
          <button
            className={`${secondaryButton} justify-self-start`}
            onClick={() => {
              const next = drafts.filter((_, i) => i !== index);
              changeDrafts(next);
              void save(next);
            }}
          >
            <Trash2 size={13} />
            Remove collection
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          className={secondaryButton}
          disabled={drafts.length >= 20}
          onClick={() => {
            changeDrafts([
              ...latestDrafts.current,
              {
                id: `collection-${crypto.randomUUID()}`,
                name: '',
                description: '',
                repository: '',
              },
            ]);
            setStatus('Add a name and repository to save the collection.');
          }}
        >
          <Plus size={14} />
          Add collection
        </button>
        <span role="status" className="flex items-center gap-1.5 text-xs text-text-secondary">
          {saving ? (
            <Loader2 size={13} className="animate-spin" />
          ) : status.startsWith('Saved') ? (
            <Check size={13} />
          ) : null}
          {saving ? 'Saving…' : status}
        </span>
      </div>
      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-error">
          <p>{error}</p>
          <button className={secondaryButton} onClick={() => void save(drafts)} disabled={saving}>
            Retry
          </button>
          <button className={secondaryButton} onClick={onReload} disabled={saving}>
            Reload shared collections
          </button>
        </div>
      )}
    </div>
  );
}

import type { GateCriterion } from '../../../../shared/types';
import { DEFAULT_COMPLIANCE_PATHS } from '../../../../shared/document-gate-config';
const field =
  'w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';
export function DocumentCriterionOptions({
  criterion,
  onChange,
}: {
  criterion: GateCriterion;
  onChange(config: Record<string, unknown>): void;
}) {
  const config = criterion.config ?? {};
  const update = (patch: Record<string, unknown>) => onChange({ ...config, ...patch });
  const source = config.source ?? 'repository';
  const paths = (config.paths ??
    (criterion.type === 'compliance_doc' ? DEFAULT_COMPLIANCE_PATHS : [])) as string[];
  return (
    <div className="w-full space-y-3 border-l-2 border-border pl-3 pb-2">
      <label className="block text-xs text-text-secondary">
        Document location
        <select
          className={field}
          value={String(source)}
          onChange={(e) => update({ source: e.target.value })}
        >
          <option value="repository">Repository files</option>
          <option value="manual">Work Item or external document · manual review</option>
        </select>
      </label>
      {source === 'manual' ? (
        <>
          <label className="block text-xs text-text-secondary">
            Where to find the document
            <textarea
              className={field}
              value={String(config.reference ?? '')}
              onChange={(e) => update({ reference: e.target.value })}
              placeholder="For example: the design document linked from the Work Item"
              rows={2}
            />
          </label>
          <p className="text-xs text-text-tertiary">
            Anvil leaves this check pending. Inspect the source document and record your judgement
            in the gate decision. A link alone does not count as verified evidence.
          </p>
        </>
      ) : (
        <>
          <label className="block text-xs text-text-secondary">
            Repository-relative file paths, one per line
            <textarea
              className={`${field} font-mono`}
              rows={3}
              value={paths.join('\n')}
              onChange={(e) => update({ paths: e.target.value.split('\n') })}
              placeholder="docs/design.md"
            />
          </label>
          <p className="text-xs text-text-tertiary">
            Exact paths only, no wildcards.{' '}
            {criterion.type === 'adr_exists'
              ? 'Leave blank to discover ADRs in conventional folders and by filename.'
              : 'Replace these defaults with documents your team uses.'}{' '}
            Files must be non-empty. Presence does not establish relevance or approval.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs text-text-secondary">
              Files required
              <select
                className={field}
                value={String(config.match ?? 'any')}
                onChange={(e) => update({ match: e.target.value })}
              >
                <option value="any">At least one listed file</option>
                <option value="all">Every listed file</option>
              </select>
            </label>
            <label className="block text-xs text-text-secondary">
              Repository scope
              <select
                className={field}
                value={String(config.repositories ?? 'all')}
                onChange={(e) => update({ repositories: e.target.value })}
              >
                <option value="all">Every linked repository</option>
                <option value="any">At least one linked repository</option>
              </select>
            </label>
          </div>
        </>
      )}
    </div>
  );
}

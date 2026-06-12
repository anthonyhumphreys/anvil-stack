import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type {
  DependencyAuditResult,
  DependencyRecord,
  LicenseAuditResult,
  PackageManager,
  SbomFormat,
} from '../../../shared/types';
import { RepoSelector } from '../shared/RepoSelector';
import { useWorkspace } from '../../contexts/WorkspaceContext';

const managers: PackageManager[] = ['npm', 'pnpm', 'yarn', 'nuget', 'python'];
const sbomFormats: Array<{ value: SbomFormat; label: string; extension: string }> = [
  { value: 'cyclonedx-json', label: 'CycloneDX JSON', extension: 'cyclonedx.json' },
  { value: 'spdx-json', label: 'SPDX JSON', extension: 'spdx.json' },
  { value: 'csv', label: 'CSV', extension: 'csv' },
];

export function DependenciesView() {
  const { repoId } = useParams<{ repoId: string }>();
  const navigate = useNavigate();
  const { activeWorkspace } = useWorkspace();
  const selectedRepo = activeWorkspace?.repos.find((repo) => repo.id === repoId);
  const [items, setItems] = useState<DependencyRecord[]>([]);
  const [query, setQuery] = useState('');
  const [auditResult, setAuditResult] = useState<DependencyAuditResult | null>(null);
  const [licenseAudit, setLicenseAudit] = useState<LicenseAuditResult | null>(null);
  const [manager, setManager] = useState<PackageManager>('npm');
  const [sbomFormat, setSbomFormat] = useState<SbomFormat>('cyclonedx-json');
  const [loading, setLoading] = useState(false);
  const [auditLoading, setAuditLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    if (!repoId) return;
    setLoading(true);
    setError(null);
    try {
      setItems(await window.anvil.dependencies.list(repoId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to list dependencies');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [repoId]);

  const filtered = useMemo(
    () => items.filter((dependency) => dependency.name.toLowerCase().includes(query.toLowerCase())),
    [items, query],
  );

  const runAudit = async () => {
    if (!repoId) return;
    setAuditLoading(true);
    setError(null);
    try {
      setAuditResult(await window.anvil.dependencies.audit(repoId, manager));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run dependency audit');
    } finally {
      setAuditLoading(false);
    }
  };

  const runLicenseAudit = async () => {
    if (!repoId) return;
    setAuditLoading(true);
    setError(null);
    try {
      setLicenseAudit(await window.anvil.dependencies.auditLicenses(repoId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run license audit');
    } finally {
      setAuditLoading(false);
    }
  };

  const exportSbom = async () => {
    if (!repoId) return;
    setError(null);
    try {
      const output = await window.anvil.dependencies.exportSbom(repoId, sbomFormat);
      const format = sbomFormats.find((candidate) => candidate.value === sbomFormat);
      downloadText(
        output,
        `${selectedRepo?.name ?? 'dependencies'}-sbom.${format?.extension ?? 'txt'}`,
        sbomFormat === 'csv' ? 'text/csv' : 'application/json',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to export SBOM');
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border-subtle px-4 py-3 text-lg font-semibold">
        Dependencies
      </div>
      {!repoId ? (
        <div className="flex-1 overflow-auto p-4">
          <RepoSelector
            indexedOnly={false}
            selectedRepoId={null}
            onSelect={(repo) => navigate(`/dependencies/${repo.id}`)}
          />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 p-4 xl:grid-cols-2">
          <div className="flex min-h-0 flex-col rounded-xl border border-border bg-bg-secondary p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <input
                className="min-w-56 flex-1 rounded border border-border bg-bg-primary px-3 py-2"
                placeholder="Search dependencies"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <button
                className="rounded bg-accent px-3 py-2 text-white disabled:opacity-50"
                disabled={loading}
                onClick={() => void refresh()}
              >
                {loading ? 'Refreshing...' : 'Refresh'}
              </button>
            </div>
            {error && (
              <div className="mb-2 rounded border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
                {error}
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-auto text-sm">
              {filtered.map((dependency) => (
                <div
                  key={`${dependency.manager}:${dependency.name}`}
                  className="mb-2 rounded border border-border-subtle p-2"
                >
                  <div className="flex flex-wrap items-center gap-2 font-medium">
                    <span>{dependency.name}</span>
                    <span className="text-text-tertiary">{dependency.version}</span>
                    <span className="rounded bg-bg-primary px-1.5 py-0.5 text-xs text-text-tertiary">
                      {dependency.manager}
                    </span>
                    <span className="rounded bg-bg-primary px-1.5 py-0.5 text-xs text-text-tertiary">
                      {dependency.license ?? 'UNKNOWN'}
                    </span>
                  </div>
                  {dependency.deprecated && (
                    <div className="mt-1 text-amber-400">
                      Deprecated. Suggested replacement:{' '}
                      {dependency.alternative ?? 'Consider maintained alternatives.'}
                    </div>
                  )}
                </div>
              ))}
              {filtered.length === 0 && (
                <div className="rounded border border-border-subtle p-3 text-text-tertiary">
                  {loading ? 'Loading dependencies...' : 'No dependencies found.'}
                </div>
              )}
            </div>
          </div>
          <div className="flex min-h-0 flex-col gap-3 rounded-xl border border-border bg-bg-secondary p-3">
            <div className="text-sm font-semibold">Audit</div>
            <div className="flex flex-wrap gap-2">
              <select
                className="rounded border border-border bg-bg-primary px-2"
                value={manager}
                onChange={(event) => setManager(event.target.value as PackageManager)}
              >
                {managers.map((candidate) => (
                  <option key={candidate}>{candidate}</option>
                ))}
              </select>
              <button
                className="rounded bg-accent px-3 py-2 text-white disabled:opacity-50"
                disabled={auditLoading}
                onClick={() => void runAudit()}
              >
                {auditLoading ? 'Running...' : 'Run Audit'}
              </button>
              <button
                className="rounded border border-border px-3 py-2 text-text-secondary"
                disabled={auditLoading}
                onClick={() => void runLicenseAudit()}
              >
                License Audit
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              <select
                className="rounded border border-border bg-bg-primary px-2"
                value={sbomFormat}
                onChange={(event) => setSbomFormat(event.target.value as SbomFormat)}
              >
                {sbomFormats.map((format) => (
                  <option key={format.value} value={format.value}>
                    {format.label}
                  </option>
                ))}
              </select>
              <button
                className="rounded border border-border px-3 py-2 text-text-secondary"
                onClick={() => void exportSbom()}
              >
                Export SBOM
              </button>
            </div>
            {auditResult && (
              <div className="rounded border border-border-subtle p-2 text-xs text-text-tertiary">
                {auditResult.command} exited {auditResult.exitCode}; output is shown for triage.
              </div>
            )}
            <pre className="min-h-0 flex-1 overflow-auto rounded bg-bg-primary p-2 text-xs">
              {auditResult
                ? [auditResult.stdout, auditResult.stderr].filter(Boolean).join('\n')
                : 'No audit output yet.'}
            </pre>
            <div className="rounded border border-border-subtle p-2 text-xs">
              {licenseAudit
                ? `${licenseAudit.total} packages checked; ${licenseAudit.unknown} missing license metadata.`
                : 'License audit reads installed package metadata where available and marks unknowns explicitly.'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function downloadText(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

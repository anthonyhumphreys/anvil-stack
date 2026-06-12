import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { SecurityAudit, SecurityFinding } from '../../../shared/types';
import { SecuritySummary } from './SecuritySummary';
import { SecurityFindingCard } from './SecurityFindingCard';
import { SecurityActions } from './SecurityActions';
import { Download, Filter } from 'lucide-react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { buildEditorUrl } from '../../utils/editor-link';

interface Props {
  audit: SecurityAudit;
}

export function SecurityAuditReport({ audit }: Props) {
  const navigate = useNavigate();
  const { activeWorkspace } = useWorkspace();
  const [findings, setFindings] = useState<SecurityFinding[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [severityFilter, setSeverityFilter] = useState<string | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);

  useEffect(() => {
    window.anvil.security.getFindings(audit.id).then(setFindings);
    setSelectedIds(new Set());
  }, [audit.id]);

  const handleDismiss = useCallback(async (findingId: string) => {
    await window.anvil.security.dismissFinding(findingId);
    setFindings((prev) => prev.map((f) => (f.id === findingId ? { ...f, dismissed: true } : f)));
  }, []);

  const handleCreateWorkItem = useCallback(async (findingId: string) => {
    const wiId = await window.anvil.security.createWorkItem(findingId);
    setFindings((prev) => prev.map((f) => (f.id === findingId ? { ...f, workItemId: wiId } : f)));
  }, []);

  const handleBulkCreateWorkItems = useCallback(async () => {
    const ids = [...selectedIds];
    const wiIds = await window.anvil.security.createWorkItemsBulk(ids);
    setFindings((prev) =>
      prev.map((f) => {
        const idx = ids.indexOf(f.id);
        if (idx >= 0) return { ...f, workItemId: wiIds[idx] };
        return f;
      }),
    );
    setSelectedIds(new Set());
  }, [selectedIds]);

  const handleExport = useCallback(async () => {
    await window.anvil.security.exportReport(audit.id);
  }, [audit.id]);

  const handleInspectPath = useCallback(
    (filePath: string) => {
      navigate(
        buildEditorUrl({
          workspaceId: activeWorkspace?.id,
          repoId: audit.repoId,
          relativePath: filePath,
          source: 'security',
          title: filePath,
        }),
      );
    },
    [activeWorkspace?.id, audit.repoId, navigate],
  );

  const handleAskChat = useCallback(
    (finding: SecurityFinding) => {
      const prompt = [
        `Help me fix this ${finding.severity} security finding.`,
        `Category: ${finding.category}.`,
        finding.affectedFiles.length ? `Affected files: ${finding.affectedFiles.join(', ')}.` : '',
        `Finding: ${finding.description}`,
        finding.remediation ? `Suggested remediation: ${finding.remediation}` : '',
        'Inspect the code, explain the risk, make the smallest safe fix, and tell me how to verify it.',
      ]
        .filter(Boolean)
        .join('\n\n');

      navigate(`/chat?prompt=${encodeURIComponent(prompt)}`);
    },
    [navigate],
  );

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === visibleFindings.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(visibleFindings.map((f) => f.id)));
    }
  };

  // Filter findings
  let visibleFindings = findings.filter((f) => showDismissed || !f.dismissed);
  if (severityFilter) {
    visibleFindings = visibleFindings.filter((f) => f.severity === severityFilter);
  }

  // Group by category
  const grouped = new Map<string, SecurityFinding[]>();
  for (const f of visibleFindings) {
    if (!grouped.has(f.category)) grouped.set(f.category, []);
    grouped.get(f.category)!.push(f);
  }

  const severityOrder = ['critical', 'high', 'medium', 'low', 'info'];
  const sortedCategories = [...grouped.entries()].sort((a, b) => {
    const aMax = Math.min(...a[1].map((f) => severityOrder.indexOf(f.severity)));
    const bMax = Math.min(...b[1].map((f) => severityOrder.indexOf(f.severity)));
    return aMax - bMax;
  });

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-text-primary">Audit Report</h2>
          <p className="text-xs text-text-secondary">
            {new Date(audit.startedAt).toLocaleString()} — {audit.scope.join(', ')}
          </p>
        </div>
        <button
          onClick={handleExport}
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary"
        >
          <Download size={14} />
          Export
        </button>
      </div>

      {/* Summary */}
      <SecuritySummary findings={findings} summary={audit.summary} />

      {/* Filters and bulk actions */}
      <div className="my-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Filter size={14} className="text-text-tertiary" />
          {['critical', 'high', 'medium', 'low', 'info'].map((sev) => (
            <button
              key={sev}
              onClick={() => setSeverityFilter(severityFilter === sev ? null : sev)}
              className={`rounded-md px-2 py-0.5 text-xs font-medium capitalize transition-colors ${
                severityFilter === sev
                  ? 'bg-accent text-white'
                  : 'bg-bg-elevated text-text-secondary hover:bg-bg-tertiary'
              }`}
            >
              {sev}
            </button>
          ))}
          <label className="ml-3 flex items-center gap-1.5 text-sm text-text-tertiary">
            <input
              type="checkbox"
              checked={showDismissed}
              onChange={(e) => setShowDismissed(e.target.checked)}
              className="rounded"
            />
            Show dismissed
          </label>
        </div>
      </div>

      {/* Bulk actions bar */}
      {selectedIds.size > 0 && (
        <SecurityActions
          selectedCount={selectedIds.size}
          totalCount={visibleFindings.length}
          onSelectAll={toggleSelectAll}
          onCreateWorkItems={handleBulkCreateWorkItems}
        />
      )}

      {/* Findings by category */}
      {sortedCategories.map(([category, catFindings]) => (
        <div key={category} className="mb-6">
          <h3 className="mb-2 text-base font-semibold text-text-primary">{category}</h3>
          <div className="space-y-2">
            {catFindings.map((finding) => (
              <SecurityFindingCard
                key={finding.id}
                finding={finding}
                selected={selectedIds.has(finding.id)}
                onToggleSelect={() => toggleSelect(finding.id)}
                onDismiss={() => handleDismiss(finding.id)}
                onCreateWorkItem={() => handleCreateWorkItem(finding.id)}
                onInspectPath={handleInspectPath}
                onAskChat={() => handleAskChat(finding)}
              />
            ))}
          </div>
        </div>
      ))}

      {visibleFindings.length === 0 && (
        <div className="rounded-lg border border-border-subtle bg-bg-secondary p-8 text-center">
          <p className="text-sm text-text-secondary">
            {findings.length === 0
              ? 'No findings in this audit.'
              : 'No findings match the current filters.'}
          </p>
        </div>
      )}
    </div>
  );
}

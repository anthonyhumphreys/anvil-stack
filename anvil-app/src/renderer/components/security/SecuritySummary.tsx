import type { SecurityFinding } from '../../../shared/types';
import { ShieldAlert, ShieldCheck } from 'lucide-react';

interface Props {
  findings: SecurityFinding[];
  summary?: string;
}

const severityConfig = [
  { key: 'critical', label: 'Critical', color: 'text-red-400', bg: 'bg-red-500/20' },
  { key: 'high', label: 'High', color: 'text-orange-400', bg: 'bg-orange-500/20' },
  { key: 'medium', label: 'Medium', color: 'text-yellow-400', bg: 'bg-yellow-500/20' },
  { key: 'low', label: 'Low', color: 'text-blue-400', bg: 'bg-blue-500/20' },
  { key: 'info', label: 'Info', color: 'text-gray-400', bg: 'bg-gray-500/20' },
];

export function SecuritySummary({ findings, summary }: Props) {
  const activeFindings = findings.filter((f) => !f.dismissed);
  const counts: Record<string, number> = {};
  for (const f of activeFindings) {
    counts[f.severity] = (counts[f.severity] || 0) + 1;
  }

  const hasCritical = (counts['critical'] || 0) > 0;

  return (
    <div className="rounded-lg border border-border bg-bg-secondary p-4">
      <div className="mb-3 flex items-center gap-2">
        {hasCritical ? (
          <ShieldAlert size={18} className="text-error" />
        ) : (
          <ShieldCheck size={18} className="text-success" />
        )}
        <h3 className="text-base font-semibold text-text-primary">Summary</h3>
      </div>

      {summary && <p className="mb-3 text-sm text-text-secondary">{summary}</p>}

      <div className="flex gap-3">
        {severityConfig.map(({ key, label, color, bg }) => (
          <div key={key} className={`flex flex-col items-center rounded-lg ${bg} px-4 py-2`}>
            <span className={`text-lg font-bold ${color}`}>{counts[key] || 0}</span>
            <span className="text-xs text-text-tertiary">{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

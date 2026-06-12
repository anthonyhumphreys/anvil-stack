import { useState, useCallback, useEffect, useRef } from 'react';
import { Package, Download, Check, Loader2 } from 'lucide-react';
import type { HandoverPack, HandoverProgress } from '../../../../shared/types';

interface Props {
  lifecycleItemId: string;
  linkedRepoIds: string[];
}

const HANDOVER_SECTIONS = [
  'Architecture Overview',
  'Module Inventory',
  'Architecture Decisions (ADRs)',
  'Impact Analysis',
  'Security Audit Report',
  'Code Review Summary',
  'Compliance Documents',
  'Gate Decisions',
  'Configuration Inventory',
] as const;

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function HandoverPackPanel({ lifecycleItemId }: Props) {
  const [packs, setPacks] = useState<HandoverPack[]>([]);
  const [loadingPacks, setLoadingPacks] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<HandoverProgress | null>(null);
  const [exportingId, setExportingId] = useState<string | null>(null);

  const unsubRef = useRef<(() => void) | null>(null);

  // ---- Fetch existing packs ----
  const fetchPacks = useCallback(async () => {
    setLoadingPacks(true);
    try {
      const list = await window.anvil.lifecycle.listHandoverPacks(lifecycleItemId);
      setPacks(list);
    } catch (err) {
      console.error('Failed to list handover packs:', err);
    } finally {
      setLoadingPacks(false);
    }
  }, [lifecycleItemId]);

  // ---- Subscribe to handover progress ----
  useEffect(() => {
    const unsub = window.anvil.lifecycle.onHandoverProgress((data) => {
      if (data.lifecycleItemId !== lifecycleItemId) return;
      setProgress(data);
      if (data.percent >= 100) {
        setTimeout(() => {
          setGenerating(false);
          setProgress(null);
          fetchPacks();
        }, 500);
      }
    });
    unsubRef.current = unsub;
    return () => {
      unsub();
      unsubRef.current = null;
    };
  }, [lifecycleItemId, fetchPacks]);

  // ---- Initial load ----
  useEffect(() => {
    fetchPacks();
  }, [fetchPacks]);

  // ---- Generate pack ----
  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setProgress({
      lifecycleItemId,
      section: 'Starting…',
      message: 'Assembling handover pack…',
      percent: 0,
    });
    try {
      await window.anvil.lifecycle.generateHandoverPack(lifecycleItemId);
      await fetchPacks();
    } catch (err) {
      console.error('Failed to generate handover pack:', err);
    } finally {
      setGenerating(false);
      setProgress(null);
    }
  }, [lifecycleItemId, fetchPacks]);

  // ---- Export / save pack ----
  const handleExport = useCallback(async (packId: string) => {
    setExportingId(packId);
    try {
      await window.anvil.lifecycle.exportHandoverPack(packId);
    } catch (err) {
      console.error('Failed to export handover pack:', err);
    } finally {
      setExportingId(null);
    }
  }, []);

  return (
    <div className="space-y-4 pt-2">
      {/* ---- Section Checklist ---- */}
      <div className="rounded-lg border border-border px-4 py-3">
        <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-text-tertiary">
          Pack Contents
        </div>
        <ul className="space-y-2">
          {HANDOVER_SECTIONS.map((section) => (
            <li key={section} className="flex items-center gap-3">
              <Check size={14} className="shrink-0 text-emerald-400" />
              <span className="text-sm text-text-primary">{section}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-text-tertiary">
          Missing sections will be included as placeholders in the generated ZIP.
        </p>
      </div>

      {/* ---- Generate Button + Progress ---- */}
      <div className="rounded-lg border border-border px-4 py-3 space-y-3">
        <div className="text-xs font-semibold uppercase tracking-wider text-text-tertiary">
          Generate
        </div>

        {generating && progress && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-text-secondary">
              <span className="flex items-center gap-1.5">
                <Loader2 size={12} className="animate-spin" />
                {progress.section && (
                  <span className="font-medium text-text-primary">{progress.section}</span>
                )}
                {progress.message && progress.section && (
                  <span className="text-text-tertiary"> — {progress.message}</span>
                )}
                {!progress.section && progress.message}
              </span>
              <span>{progress.percent}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-tertiary">
              <div
                className="h-full rounded-full bg-accent transition-all duration-300"
                style={{ width: `${Math.min(progress.percent, 100)}%` }}
              />
            </div>
          </div>
        )}

        <button
          onClick={handleGenerate}
          disabled={generating}
          className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {generating ? <Loader2 size={14} className="animate-spin" /> : <Package size={14} />}
          {generating ? 'Generating…' : 'Generate Handover Pack'}
        </button>
      </div>

      {/* ---- Previous Packs ---- */}
      <div className="rounded-lg border border-border px-4 py-3">
        <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-text-tertiary">
          Previous Packs
        </div>

        {loadingPacks ? (
          <div className="flex h-16 items-center justify-center">
            <Loader2 size={18} className="animate-spin text-accent" />
          </div>
        ) : packs.length === 0 ? (
          <p className="text-sm text-text-tertiary">
            No packs generated yet. Click "Generate Handover Pack" above to create one.
          </p>
        ) : (
          <ul className="space-y-2">
            {packs.map((pack) => (
              <li
                key={pack.id}
                className="flex items-center justify-between rounded-lg border border-border px-3 py-2"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Package size={14} className="shrink-0 text-text-tertiary" />
                  <span className="text-sm text-text-primary truncate">
                    {formatDate(pack.generatedAt)}
                  </span>
                  <span className="text-xs text-text-tertiary shrink-0">
                    ({pack.sections.filter((s) => s.included).length}/{pack.sections.length}{' '}
                    sections)
                  </span>
                </div>
                <button
                  onClick={() => handleExport(pack.id)}
                  disabled={exportingId === pack.id}
                  title="Save as ZIP"
                  className="ml-3 flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-tertiary disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                >
                  {exportingId === pack.id ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Download size={12} />
                  )}
                  Save
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

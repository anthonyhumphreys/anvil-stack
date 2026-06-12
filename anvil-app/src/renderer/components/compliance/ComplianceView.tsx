import { useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Scale,
  ShieldCheck,
  FileText,
  ScrollText,
  Loader2,
  RefreshCw,
  Clock,
  AlertTriangle,
  Check,
  ChevronRight,
} from 'lucide-react';
import type { ComplianceDocType, ComplianceDocument } from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';

const DOC_TYPES: {
  type: ComplianceDocType;
  label: string;
  description: string;
  icon: typeof Scale;
}[] = [
  {
    type: 'dpia',
    label: 'DPIA',
    description:
      'Data Protection Impact Assessment — UK GDPR compliant assessment of data processing risks',
    icon: ShieldCheck,
  },
  {
    type: 'privacy-policy',
    label: 'Privacy Policy',
    description: 'UK GDPR and DPA 2018 compliant privacy policy for your application',
    icon: ScrollText,
  },
  {
    type: 'terms-of-service',
    label: 'Terms of Service',
    description: 'Terms of Service compliant with UK consumer law and the Consumer Rights Act 2015',
    icon: FileText,
  },
];

export function ComplianceView() {
  const { repos } = useWorkspace();
  const indexedRepos = useMemo(() => repos.filter((r) => r.status === 'indexed'), [repos]);

  const [selectedRepoId, setSelectedRepoId] = useState('');
  const [existingDocs, setExistingDocs] = useState<ComplianceDocument[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<ComplianceDocument | null>(null);
  const [generating, setGenerating] = useState<ComplianceDocType | null>(null);
  const [progress, setProgress] = useState<{ message: string; percent: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Auto-select first indexed repo
  useEffect(() => {
    if (!selectedRepoId && indexedRepos.length > 0) {
      setSelectedRepoId(indexedRepos[0].id);
    }
  }, [indexedRepos, selectedRepoId]);

  // Load existing docs
  const refreshDocs = useCallback(async () => {
    if (!selectedRepoId) return;
    try {
      const docs = await window.anvil.compliance.list(selectedRepoId);
      setExistingDocs(docs);
    } catch {
      /* ignore */
    }
  }, [selectedRepoId]);

  useEffect(() => {
    refreshDocs();
    setSelectedDoc(null);
  }, [refreshDocs]);

  // Progress listener
  useEffect(() => {
    const cleanup = window.anvil.compliance.onProgress((data) => {
      if (data.repoId === selectedRepoId) {
        setProgress({ message: data.message, percent: data.percent });
      }
    });
    return cleanup;
  }, [selectedRepoId]);

  const handleGenerate = async (docType: ComplianceDocType) => {
    setGenerating(docType);
    setProgress({ message: 'Starting...', percent: 0 });
    setError(null);
    try {
      const doc = await window.anvil.compliance.generate(selectedRepoId, docType);
      setSelectedDoc(doc);
      await refreshDocs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(null);
      setProgress(null);
    }
  };

  const handleViewDoc = async (docType: ComplianceDocType) => {
    try {
      const doc = await window.anvil.compliance.read(selectedRepoId, docType);
      if (doc) setSelectedDoc(doc);
    } catch {
      /* ignore */
    }
  };

  const existingMap = useMemo(() => {
    const map = new Map<ComplianceDocType, ComplianceDocument>();
    for (const doc of existingDocs) map.set(doc.docType, doc);
    return map;
  }, [existingDocs]);

  if (indexedRepos.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
        <Scale size={48} className="text-text-tertiary" />
        <h2 className="text-lg font-semibold text-text-primary">Data & Compliance</h2>
        <p className="max-w-md text-sm text-text-secondary">
          Index a repository first. The compliance tools analyse your codebase to generate DPIA
          documents, Privacy Policies, and Terms of Service.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border bg-bg-secondary px-4 py-3">
        <Scale size={20} className="text-accent" />
        <h2 className="text-base font-semibold text-text-primary">Data & Compliance</h2>
        <select
          value={selectedRepoId}
          onChange={(e) => setSelectedRepoId(e.target.value)}
          className="ml-auto rounded-lg border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary"
        >
          {indexedRepos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="flex items-center gap-2 border-b border-error/20 bg-error/5 px-4 py-2 text-xs text-error">
          <AlertTriangle size={12} />
          {error}
          <button onClick={() => setError(null)} className="ml-auto text-error/60 hover:text-error">
            dismiss
          </button>
        </div>
      )}

      {/* Progress bar */}
      {generating && progress && (
        <div className="border-b border-border-subtle bg-bg-primary px-4 py-2">
          <div className="flex items-center gap-2 text-xs text-text-secondary">
            <Loader2 size={12} className="animate-spin text-accent" />
            {progress.message}
          </div>
          <div className="mt-1 h-1 rounded-full bg-bg-tertiary">
            <div
              className="h-full rounded-full bg-accent transition-all"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* Left panel — doc type cards */}
        <div className="w-96 shrink-0 overflow-y-auto border-r border-border p-4">
          <p className="mb-4 text-xs text-text-tertiary">
            Generate compliance documents by analysing your codebase. Documents are saved to{' '}
            <code className="rounded bg-bg-tertiary px-1">docs/</code> in the repository.
          </p>

          <div className="space-y-3">
            {DOC_TYPES.map(({ type, label, description, icon: Icon }) => {
              const existing = existingMap.get(type);
              const isGenerating = generating === type;

              return (
                <div
                  key={type}
                  className={`rounded-lg border p-4 transition-colors ${
                    selectedDoc?.docType === type
                      ? 'border-accent/40 bg-accent/5'
                      : 'border-border hover:border-border-subtle hover:bg-bg-tertiary/30'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <Icon size={20} className="mt-0.5 shrink-0 text-accent" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold text-text-primary">{label}</h3>
                        {existing && (
                          <span className="flex items-center gap-0.5 rounded bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success">
                            <Check size={10} />
                            Generated
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-text-secondary">{description}</p>

                      {existing && (
                        <p className="mt-1 flex items-center gap-1 text-[10px] text-text-tertiary">
                          <Clock size={10} />
                          {new Date(existing.generatedAt).toLocaleDateString()} at{' '}
                          {new Date(existing.generatedAt).toLocaleTimeString()}
                        </p>
                      )}

                      <div className="mt-3 flex items-center gap-2">
                        <button
                          onClick={() => handleGenerate(type)}
                          disabled={!!generating}
                          className="flex items-center gap-1.5 rounded-md border border-accent/30 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent/20 disabled:opacity-40"
                        >
                          {isGenerating ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : existing ? (
                            <RefreshCw size={12} />
                          ) : (
                            <Scale size={12} />
                          )}
                          {existing ? 'Regenerate' : 'Generate'}
                        </button>
                        {existing && (
                          <button
                            onClick={() => handleViewDoc(type)}
                            className="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                          >
                            View
                            <ChevronRight size={12} />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-6 rounded-lg border border-border-subtle bg-bg-tertiary/30 p-3">
            <p className="text-xs font-semibold text-text-tertiary">Important</p>
            <p className="mt-1 text-xs text-text-tertiary">
              Generated documents are a starting point based on code analysis. Look for
              <code className="mx-0.5 rounded bg-bg-primary px-1 text-warning">
                [ACTION REQUIRED]
              </code>
              markers where human input is needed. Always have documents reviewed by a qualified
              legal or data protection professional.
            </p>
          </div>
        </div>

        {/* Right panel — document preview */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {selectedDoc ? (
            <>
              <div className="flex items-center gap-2 border-b border-border-subtle bg-bg-secondary px-4 py-2">
                <FileText size={14} className="text-accent" />
                <span className="text-sm font-medium text-text-primary">{selectedDoc.title}</span>
                <span className="text-xs text-text-tertiary">
                  {selectedDoc.repoName} / docs / {selectedDoc.filename}
                </span>
              </div>
              <div className="flex-1 overflow-y-auto px-8 py-6">
                <article className="prose prose-invert prose-sm max-w-none">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{selectedDoc.content}</ReactMarkdown>
                </article>
              </div>
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
              <Scale size={40} className="text-text-tertiary" />
              <p className="max-w-sm text-sm text-text-secondary">
                Select a document type and generate it, or view an existing document.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

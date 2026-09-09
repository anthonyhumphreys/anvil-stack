import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import type { ChangeReview, ReviewNativeEvidence } from '../../../shared/change-review-types';
import { parsePreviewBuild } from '../../../shared/preview-build';

const field =
  'w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus-visible:outline-2 focus-visible:outline-accent';

export function NativeEvidencePanel({
  review,
  onUpdate,
}: {
  review: ChangeReview;
  onUpdate: (review: ChangeReview) => void;
}) {
  const id = useId();
  const [manifest, setManifest] = useState('');
  const [status, setStatus] = useState<ReviewNativeEvidence['status']>('unavailable');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  async function record(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setSaved(false);
    try {
      const identity = parsePreviewBuild(manifest);
      if (!identity) throw new Error('Paste the preview-manifest.json from the build artifact.');
      if (identity.headSha !== review.candidate.head)
        throw new Error(
          'This preview is for a different commit. Build the current candidate first.',
        );
      const metadata = JSON.parse(manifest) as { signing?: string; status?: string };
      if (status === 'passed' && metadata.status !== 'built')
        throw new Error('A failed or incomplete build cannot have a passed native check.');
      const signing = metadata.signing;
      if (signing !== 'unsigned' && signing !== 'signed' && signing !== 'unavailable')
        throw new Error('The manifest must specify whether signing is available.');
      setBusy(true);
      const updated = await window.anvil.changeReview.recordNativeEvidence(review.id, {
        buildId: identity.buildId,
        headSha: identity.headSha,
        platform: identity.platform,
        arch: identity.arch,
        signing,
        status,
        notes: notes.trim(),
      });
      onUpdate(updated);
      setNotes('');
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3 border-t border-border py-4" aria-labelledby={`${id}-heading`}>
      <div>
        <h3 id={`${id}-heading`} className="text-sm font-semibold text-text-primary">
          Native macOS checks
        </h3>
        <p className="mt-1 max-w-prose text-sm text-text-secondary">
          Record what you observed in the installed candidate. Browser runs do not verify Electron
          behavior.
        </p>
      </div>
      {(review.nativeEvidence?.length ?? 0) === 0 ? (
        <p className="text-sm text-text-secondary">No native checks recorded for this review.</p>
      ) : (
        <ul className="divide-y divide-border">
          {[...(review.nativeEvidence ?? [])].reverse().map((evidence) => {
            const stale =
              evidence.headSha !== review.candidate.head ||
              evidence.candidateTree !== review.candidate.tree ||
              review.freshness !== 'current';
            return (
              <li key={evidence.id} className="space-y-1 py-3 text-sm">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span
                    className={stale ? 'font-medium text-warning' : 'font-medium text-text-primary'}
                  >
                    {stale ? 'Stale · ' : ''}
                    {evidence.status === 'passed'
                      ? 'Passed'
                      : evidence.status === 'failed'
                        ? 'Failed'
                        : evidence.status === 'unsupported'
                          ? 'Unsupported'
                          : 'Unavailable'}
                  </span>
                  <span className="text-text-secondary">
                    macOS {evidence.arch} ·{' '}
                    {evidence.signing === 'unavailable' ? 'Signing unavailable' : evidence.signing}
                  </span>
                </div>
                <p className="break-all font-mono text-xs text-text-secondary">
                  {evidence.buildId}
                </p>
                <p className="whitespace-pre-wrap break-words text-text-primary">
                  {evidence.notes}
                </p>
                <p className="text-xs text-text-secondary">
                  Observed by {evidence.reviewer} · {new Date(evidence.recordedAt).toLocaleString()}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      <details className="group">
        <summary className="w-fit cursor-pointer rounded-sm text-sm font-medium text-text-primary focus-visible:outline-2 focus-visible:outline-accent">
          Record a native check
        </summary>
        <form onSubmit={(event) => void record(event)} className="mt-3 max-w-2xl space-y-3">
          <p className="text-sm text-text-secondary">
            Run the Anvil candidate macOS preview workflow with the PR number and current full
            commit SHA. Download the build artifact and paste its manifest below. Internal previews
            are unsigned.
          </p>
          <label className="block space-y-1 text-sm text-text-secondary">
            <span>Build manifest</span>
            <textarea
              className={`${field} font-mono text-xs`}
              rows={4}
              value={manifest}
              onChange={(event) => setManifest(event.target.value)}
              required
              maxLength={64000}
              spellCheck={false}
              placeholder="Paste preview-manifest.json"
              disabled={busy}
            />
          </label>
          <label className="block space-y-1 text-sm text-text-secondary">
            <span>Observed result</span>
            <select
              className={field}
              value={status}
              onChange={(event) => setStatus(event.target.value as ReviewNativeEvidence['status'])}
              disabled={busy}
            >
              <option value="unavailable">Unavailable</option>
              <option value="unsupported">Unsupported on this Mac</option>
              <option value="failed">Failed</option>
              <option value="passed">Passed the checks described below</option>
            </select>
          </label>
          <label className="block space-y-1 text-sm text-text-secondary">
            <span>Checks, results and limitations</span>
            <textarea
              className={field}
              rows={3}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              required
              maxLength={8000}
              disabled={busy}
              placeholder="macOS version, checks performed, recovery steps, failures and anything skipped"
            />
          </label>
          {review.freshness !== 'current' && (
            <p className="text-sm text-warning">
              Refresh the candidate before recording native evidence.
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-error">
              {error}
            </p>
          )}
          {saved && (
            <p role="status" className="text-sm text-text-secondary">
              Native check recorded for this build.
            </p>
          )}
          <button
            type="submit"
            disabled={busy || !manifest.trim() || !notes.trim() || review.freshness !== 'current'}
            className="rounded-md border border-border px-3 py-2 text-sm text-text-primary hover:bg-bg-tertiary focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Recording…' : 'Record native check'}
          </button>
        </form>
      </details>
    </section>
  );
}

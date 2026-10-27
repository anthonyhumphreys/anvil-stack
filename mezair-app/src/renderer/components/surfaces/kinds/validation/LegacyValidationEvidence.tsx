import { useState } from 'react';
import type { ChangeReview, ReviewCapture } from '../../../../../shared/change-review-types';

function SavedCapture({
  reviewId,
  runId,
  capture,
}: {
  reviewId: string;
  runId: string;
  capture: ReviewCapture;
}) {
  const [image, setImage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  async function load() {
    if (image || loading) return;
    setLoading(true);
    setError('');
    try {
      setImage(await window.mezair.changeReview.artifact(reviewId, runId, capture.id));
    } catch {
      setError('This saved capture is unavailable. Its original record has been retained.');
    } finally {
      setLoading(false);
    }
  }
  return (
    <details
      onToggle={(event) => {
        if (event.currentTarget.open) void load();
      }}
    >
      <summary className="cursor-pointer rounded-sm py-1 focus-visible:outline-2 focus-visible:outline-accent">
        {capture.viewport} · {capture.outcome}
      </summary>
      {loading && <p role="status">Loading saved capture…</p>}
      {error && (
        <p role="alert" className="text-warning">
          {error}
        </p>
      )}
      {image && (
        <img
          src={image}
          alt={`Historical ${capture.viewport} capture, ${capture.outcome}`}
          className="mt-2 h-auto max-h-96 max-w-full object-contain"
        />
      )}
    </details>
  );
}

/** Original records stay readable, without reviving the scenario configuration form. */
export function LegacyValidationEvidence({ reviewId }: { reviewId: string }) {
  const [review, setReview] = useState<ChangeReview>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  async function load() {
    if (review || loading) return;
    setLoading(true);
    setError('');
    try {
      setReview(await window.mezair.changeReview.get(reviewId));
    } catch {
      setError('The original evidence could not be loaded. Reopen this thread to try again.');
    } finally {
      setLoading(false);
    }
  }
  return (
    <details
      className="space-y-2 text-xs text-text-secondary"
      onToggle={(event) => {
        if (event.currentTarget.open) void load();
      }}
    >
      <summary className="w-fit cursor-pointer rounded-sm py-1 focus-visible:outline-2 focus-visible:outline-accent">
        Original review evidence
      </summary>
      {loading && <p role="status">Loading original evidence…</p>}
      {error && (
        <p role="alert" className="text-warning">
          {error}
        </p>
      )}
      {review && (
        <div className="space-y-3">
          <p className="max-w-prose">
            Saved evidence for {review.title}. Historical outcomes apply to their recorded candidate
            and criteria.
          </p>
          {review.runs.map((run) => (
            <details key={run.id} className="space-y-2">
              <summary className="cursor-pointer rounded-sm py-1 focus-visible:outline-2 focus-visible:outline-accent">
                {run.outcome} · {run.startedAt} · {run.candidate.head.slice(0, 12)}
              </summary>
              {run.error && <p className="text-warning">{run.error}</p>}
              <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                <div>
                  <p className="font-medium">Base</p>
                  {run.base.map((capture) => (
                    <SavedCapture
                      key={capture.id}
                      reviewId={reviewId}
                      runId={run.id}
                      capture={capture}
                    />
                  ))}
                </div>
                <div>
                  <p className="font-medium">Candidate</p>
                  {run.candidateCaptures.map((capture) => (
                    <SavedCapture
                      key={capture.id}
                      reviewId={reviewId}
                      runId={run.id}
                      capture={capture}
                    />
                  ))}
                </div>
              </div>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-bg-primary p-3 font-mono">
                {run.log || 'No output was retained.'}
              </pre>
            </details>
          ))}
          {review.nativeEvidence?.map((entry) => (
            <p key={entry.id} className="max-w-prose whitespace-pre-wrap">
              Native check · {entry.status} · {entry.platform}/{entry.arch}
              <br />
              {entry.notes}
            </p>
          ))}
          {review.decisions.map((entry) => (
            <p key={entry.id} className="max-w-prose whitespace-pre-wrap">
              Historical decision · {entry.outcome} · {entry.at}
              <br />
              {entry.note}
            </p>
          ))}
        </div>
      )}
    </details>
  );
}

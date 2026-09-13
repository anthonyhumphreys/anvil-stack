import { Link } from 'react-router-dom';
import { useState } from 'react';
import { Check, Clipboard, Download, ArrowUpRight } from 'lucide-react';
import type { DojoReport } from '../../../shared/types';
import type {
  DojoAnalytics,
  DojoRecommendationState,
  DojoRecommendationStatus,
} from '../../../shared/dojo-types';
import { copyTextToClipboard } from '../../utils/clipboard';
import { buttonClass, fieldClass, skillMarkdown, downloadText } from './dojo-format';

export function DojoCoachingPanel({
  report,
  data,
  onUpdate,
}: {
  report: DojoReport | null;
  data: DojoAnalytics | null;
  onUpdate: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const states = data?.followThrough ?? [];
  const update = async (key: string, status: DojoRecommendationStatus) => {
    if (!report) return;
    setBusy(key);
    setError(null);
    try {
      await window.anvil.dojo.setRecommendationState(report.workspaceId, report.id, key, status);
      await onUpdate();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update recommendation.');
    } finally {
      setBusy(null);
    }
  };
  const copy = async (key: string, text: string) => {
    try {
      await copyTextToClipboard(text);
      setCopied(key);
    } catch {
      setError('Could not copy. Download the skill instead.');
    }
  };
  const control = (key: string) => {
    const state = states.find((s) => s.reportId === report?.id && s.key === key);
    return (
      <label className="flex items-center gap-2 text-xs text-text-tertiary">
        Follow-through
        <select
          aria-label={`Recommendation status ${key}`}
          value={state?.status ?? 'suggested'}
          disabled={busy !== null}
          onChange={(e) => void update(key, e.target.value as DojoRecommendationStatus)}
          className={fieldClass}
        >
          {['suggested', 'accepted', 'applied', 'dismissed'].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
    );
  };
  return (
    <div className="space-y-6">
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      <FollowThrough states={states} data={data} />
      {!report ? (
        <p className="py-10 text-center text-sm text-text-tertiary">
          Run a review to receive evidence-based coaching and skill drafts.
        </p>
      ) : (
        <>
          {report.status !== 'completed' && (
            <div
              role="status"
              className="rounded-lg border border-border p-4 text-sm text-text-secondary"
            >
              {report.status === 'running'
                ? 'Your review is running. Recommendations will appear when it completes.'
                : (report.errorMessage ?? 'This review failed. Run a new review to retry.')}
            </div>
          )}
          {report.summary && (
            <section className="border-b border-border pb-5">
              <h2 className="text-base font-semibold text-text-primary">Coach’s read</h2>
              <p className="mt-3 max-w-[75ch] text-sm leading-relaxed text-text-secondary">
                {report.summary}
              </p>
              <p className="mt-3 text-xs text-text-tertiary">
                {report.sampleMessageCount} sampled messages · {report.metrics.correctionCount}/
                {report.metrics.userMessageCount} user messages matched correction phrases
              </p>
            </section>
          )}
          {report.observations.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-text-primary">What to change</h2>
              <div className="mt-3 divide-y divide-border-subtle">
                {report.observations.map((o, i) => (
                  <article key={i} className="py-4">
                    <div className="flex flex-wrap items-center gap-3">
                      <h3 className="text-sm font-medium text-text-primary">{o.title}</h3>
                      <span
                        className={`text-xs ${o.impact === 'high' ? 'text-error' : o.impact === 'medium' ? 'text-warning' : 'text-info'}`}
                      >
                        {o.impact} impact · {o.category}
                      </span>
                    </div>
                    <p className="mt-2 max-w-[75ch] text-sm leading-relaxed text-text-secondary">
                      {o.detail}
                    </p>
                  </article>
                ))}
              </div>
            </section>
          )}
          <section>
            <div className="flex flex-wrap justify-between gap-3">
              <h2 className="text-base font-semibold text-text-primary">
                Crafted for your workflow
              </h2>
              <span className="text-xs text-text-tertiary">Reviewable SKILL.md drafts</span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-text-tertiary">
              Built from repeated evidence in this workspace. Review before installing; copying or
              downloading does not mark a skill applied.
            </p>
            {(report.craftedSkills ?? []).length === 0 ? (
              <p className="mt-4 text-sm text-text-tertiary">
                {report.status === 'completed'
                  ? 'No crafted drafts in this review. A new review can generate skills when repeated evidence supports them.'
                  : 'Drafts appear after a successful review.'}
              </p>
            ) : (
              <div className="mt-4 divide-y divide-border">
                {report.craftedSkills!.map((skill, i) => {
                  const key = `crafted:${i}`;
                  const md = skillMarkdown(skill);
                  return (
                    <article key={key} className="py-5 first:pt-0">
                      <div className="flex flex-wrap justify-between gap-3">
                        <h3 className="font-mono text-sm font-semibold text-text-primary">
                          {skill.name}
                        </h3>
                        {control(key)}
                      </div>
                      <p className="mt-2 text-sm text-text-secondary">{skill.description}</p>
                      <p className="mt-2 text-xs text-text-tertiary">
                        {skill.reason} · {skill.evidenceIds.length} supporting messages
                      </p>
                      <p className="mt-2 text-xs text-text-tertiary">
                        Save as <code>{skill.name}/SKILL.md</code> in your skills directory.
                      </p>
                      <details className="mt-4">
                        <summary className="cursor-pointer text-sm text-info">
                          Preview skill and evidence
                        </summary>
                        <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-bg-primary p-4 font-mono text-xs leading-relaxed text-text-secondary">
                          {md}
                        </pre>
                        <p className="mt-2 break-all font-mono text-xs text-text-tertiary">
                          Evidence message IDs: {skill.evidenceIds.join(', ')}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-3">
                          {skill.evidenceThreads?.map((e, i) => (
                            <Link
                              key={e.messageId}
                              to={`/chat?thread=${encodeURIComponent(e.threadId)}`}
                              className="text-xs text-info underline underline-offset-4"
                            >
                              Open evidence conversation {i + 1}
                            </Link>
                          ))}
                        </div>
                      </details>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <button className={buttonClass} onClick={() => void copy(key, md)}>
                          {copied === key ? <Check size={14} /> : <Clipboard size={14} />}Copy
                          SKILL.md
                        </button>
                        <button
                          className={buttonClass}
                          onClick={() => downloadText('SKILL.md', md)}
                        >
                          <Download size={14} />
                          Download
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
          <section>
            <h2 className="text-base font-semibold text-text-primary">Curated matches</h2>
            <p className="mt-2 text-xs text-text-tertiary">
              Selected from Matt Pocock’s skills and pstack.
            </p>
            <div className="mt-3 divide-y divide-border-subtle">
              {report.skillRecommendations.map((s, i) => (
                <article key={`${s.library}:${s.skill}`} className="py-4">
                  <div className="flex flex-wrap justify-between gap-3">
                    <div>
                      <h3 className="font-mono text-sm font-medium text-text-primary">{s.skill}</h3>
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 inline-flex items-center gap-1 text-xs text-info underline underline-offset-4"
                      >
                        {s.library}
                        <ArrowUpRight size={12} />
                      </a>
                    </div>
                    {control(`curated:${i}`)}
                  </div>
                  <p className="mt-2 max-w-[75ch] text-sm text-text-secondary">{s.reason}</p>
                </article>
              ))}
            </div>
            {report.skillRecommendations.length === 0 && (
              <p className="mt-4 text-sm text-text-tertiary">
                No strong catalog match in this review.
              </p>
            )}
          </section>
          {report.promptRecommendations.length > 0 && (
            <section>
              <h2 className="text-base font-semibold text-text-primary">
                Instructions worth keeping
              </h2>
              <div className="mt-3 divide-y divide-border-subtle">
                {report.promptRecommendations.map((p, i) => (
                  <article key={i} className="py-4">
                    <div className="flex flex-wrap justify-between gap-3">
                      <h3 className="text-sm font-medium text-text-primary">{p.title}</h3>
                      {control(`prompt:${i}`)}
                    </div>
                    <p className="mt-2 text-xs text-text-tertiary">
                      Seen {p.evidenceCount} times · {p.reason}
                    </p>
                    <pre className="my-3 whitespace-pre-wrap rounded-lg bg-bg-primary p-3 font-mono text-xs leading-relaxed text-text-secondary">
                      {p.prompt}
                    </pre>
                    <button
                      className={buttonClass}
                      onClick={() => void copy(`prompt:${i}`, p.prompt)}
                    >
                      {copied === `prompt:${i}` ? <Check size={14} /> : <Clipboard size={14} />}Copy
                      instruction
                    </button>
                  </article>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
function FollowThrough({
  states,
  data,
}: {
  states: DojoRecommendationState[];
  data: DojoAnalytics | null;
}) {
  const applied = states.filter((s) => s.status === 'applied' && s.appliedAt);
  const first = applied.map((s) => s.appliedAt!).sort()[0];
  const before = data?.runs.filter((r) => first && r.startedAt < first) ?? [];
  const after = data?.runs.filter((r) => first && r.startedAt >= first) ?? [];
  const rate = (runs: typeof before) => {
    const users = runs.reduce((n, r) => n + r.userMessages, 0);
    return users
      ? `${((runs.reduce((n, r) => n + r.corrections, 0) / users) * 100).toFixed(1)} / 100 messages`
      : 'Not enough data';
  };
  return (
    <section className="border-b border-border pb-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-text-primary">Workspace follow-through</h2>
        <div className="flex flex-wrap gap-4 text-xs text-text-secondary">
          {['accepted', 'applied', 'dismissed'].map((status) => (
            <span key={status} className="capitalize">
              <span className="font-semibold tabular-nums">
                {states.filter((s) => s.status === status).length}
              </span>{' '}
              {status}
            </span>
          ))}
        </div>
      </div>
      {data && (
        <p className="mt-2 text-xs text-text-tertiary">
          Recommendation totals cover all workspace reviews. Session comparison:{' '}
          {new Date(data.windowStart).toLocaleDateString()} to{' '}
          {new Date(data.windowEnd).toLocaleDateString()}. Change this window in Performance.
        </p>
      )}
      {first ? (
        <>
          <p className="mt-3 text-sm text-text-secondary">
            Correction rate before / after first application: {rate(before)} → {rate(after)}
          </p>
          <p className="mt-1 text-xs text-text-tertiary">
            {before.length} / {after.length} sessions in this window. Observational only; tasks and
            models may differ.
          </p>
        </>
      ) : (
        <p className="mt-3 text-xs text-text-tertiary">
          Mark a recommendation applied after using it. Later sessions provide evidence of whether
          friction changes.
        </p>
      )}
    </section>
  );
}

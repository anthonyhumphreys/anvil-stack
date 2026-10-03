/**
 * Tiered repo indexing contracts (first-run-to-first-change remediation §4.1–4.2).
 *
 * Readiness tiers: a repo is `connected` as soon as git metadata is known,
 * `mapped` after the fast structural pass (walk, languages, frameworks,
 * modules, repository map graph, fallback summary), and `enriched` once the
 * background LLM pass (module summaries + overview) completes.
 */
export type RepoIndexTier = 'connected' | 'mapped' | 'enriched';

/** The tier a queue job drives the repo towards. */
export type RepoIndexJobTier = 'mapped' | 'enriched';

export type RepoIndexJobReason = 'connect' | 'manual' | 'commit' | 'scaffold';

export type RepoIndexJobState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/** Persisted row from `repo_index_jobs`, exposed to the renderer for hydration. */
export interface RepoIndexJob {
  id: string;
  repoId: string;
  tier: RepoIndexJobTier;
  state: RepoIndexJobState;
  reason: RepoIndexJobReason;
  progress: number;
  message: string;
  error?: string;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface RepoIndexEnqueueOptions {
  reason: RepoIndexJobReason;
  /** Defaults to both tiers: `['mapped', 'enriched']`. */
  tiers?: RepoIndexJobTier[];
}

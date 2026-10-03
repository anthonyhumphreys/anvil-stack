// Bootstrap recipe contract (spec §7): the executable setup steps a
// workspace declares after its repositories are materialised.
//
// A recipe is data, not a workflow language: ordered `command` and
// `verify` steps only. The recipe travels inside the synced workspace
// definition; its digest — together with the repository commits and the
// effective execution policy — is pinned in each target's LOCAL approval
// record. Approvals never sync, and automatic remote setup is permitted
// only when the target already approved the exact effective recipe and
// source policy.
//
// Credential boundary: a step names the environment variables it may
// receive (`envNames`); values are bound at run time from target-local
// configuration. Ambient credentials are stripped by default — a recipe
// can never smuggle a secret through a synced definition.

import { canonicalizeJson } from './sync.js';

export const BOOTSTRAP_RECIPE_SCHEMA = 1;

export type BootstrapPlatform = 'darwin' | 'linux' | 'win32';

/**
 * How the runner may treat a step whose result is uncertain after a
 * crash or stop. Non-idempotent work defaults to inspection: the UI
 * must show uncertainty rather than auto-replaying it.
 */
export type BootstrapRetry = 'safe' | 'inspect-before-retry' | 'never';

export type BootstrapStepKind = 'command' | 'verify';

export interface BootstrapStep {
  /** Stable identifier — step state journals reference it. */
  id: string;
  kind: BootstrapStepKind;
  /** Repo-relative working directory; '.' is the checkout root. */
  workingDirectory: string;
  /**
   * Argument-safe invocation. Exactly one of `argv` or `shell` is set.
   * `shell` requires the approval record to flag explicit shell consent —
   * it is executable repository code and must be explained at approval.
   */
  argv?: readonly string[];
  shell?: string;
  /** Hard timeout for the process group. */
  timeoutMs: number;
  /** Names (never values) of env bindings the runner may supply. */
  envNames: readonly string[];
  retry: BootstrapRetry;
}

export interface BootstrapRecipe {
  schemaVersion: typeof BOOTSTRAP_RECIPE_SCHEMA;
  /** Platforms the recipe supports; absent means all supported. */
  platforms?: readonly BootstrapPlatform[];
  steps: readonly BootstrapStep[];
}

/** Step lifecycle: pending → running → verified, or failed/unknown-outcome. */
export type BootstrapStepState =
  | 'pending'
  | 'running'
  | 'verified'
  | 'failed'
  | 'unknown-outcome';

export const BOOTSTRAP_STEP_TRANSITIONS: Record<
  BootstrapStepState,
  readonly BootstrapStepState[]
> = {
  pending: ['running', 'failed'],
  running: ['verified', 'failed', 'unknown-outcome'],
  verified: [],
  failed: [],
  'unknown-outcome': [],
};

export function canTransitionBootstrapStep(
  from: BootstrapStepState,
  to: BootstrapStepState,
): boolean {
  return BOOTSTRAP_STEP_TRANSITIONS[from].includes(to);
}

/** A single verification check attached to a `verify` step's outcome. */
export interface BootstrapVerification {
  stepId: string;
  ok: boolean;
  /** Bounded, sanitized evidence — never raw env or credentials. */
  detail: string;
}

/**
 * Canonical string the bootstrap digest commits to: recipe content,
 * exact repository commits, and the effective execution policy. Both
 * sides hash this with their own sha256 (node:crypto on desktop,
 * WebCrypto in the worker) — the contract itself stays dependency-free.
 */
export function bootstrapDigestInput(input: {
  recipe: BootstrapRecipe;
  repositoryCommits: Readonly<Record<string, string>>;
  executionPolicy: unknown;
}): string {
  return canonicalizeJson({
    schemaVersion: input.recipe.schemaVersion,
    recipe: input.recipe,
    repositoryCommits: input.repositoryCommits,
    executionPolicy: input.executionPolicy,
  });
}

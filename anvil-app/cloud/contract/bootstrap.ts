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

/**
 * What a recipe digest commits to: recipe content plus the exact inputs
 * it runs against — repository commits and the effective execution
 * policy. The approval record pins this digest so a changed recipe,
 * commit, or policy silently cannot reuse an old approval.
 */
export interface BootstrapDigestInputs {
  /** Canonical JSON of the recipe. */
  recipeCanonical: string;
  /** repositoryId → resolved commit for every required repo. */
  repositoryCommits: Readonly<Record<string, string>>;
  /** Canonical JSON of the target's effective execution policy. */
  executionPolicyCanonical: string;
}

/** A single verification check attached to a `verify` step's outcome. */
export interface BootstrapVerification {
  stepId: string;
  ok: boolean;
  /** Bounded, sanitized evidence — never raw env or credentials. */
  detail: string;
}

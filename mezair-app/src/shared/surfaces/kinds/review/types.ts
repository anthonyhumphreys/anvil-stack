// Review surface payload (docs/plans/inline-artifacts-and-canvas-tools.md §8.1).
// Process-neutral: main validates and builds it, the renderer reads it.

export type ReviewScopeType = 'turn' | 'working-tree' | 'pull-request' | 'commit-range';

export interface ReviewScope {
  type: ReviewScopeType;
  repoId: string;
  /** Commit-range: `base..head`. Pull request: the head ref, when known. */
  ref?: string;
  pullRequestId?: string;
  /** Human title, e.g. the PR title. */
  title?: string;
}

export type ReviewDecision = 'ship' | 'ship-with-fixes' | 'needs-work' | 'blocked';

export interface ReviewVerdict {
  decision: ReviewDecision;
  /** One sentence, written like a senior engineer's sign-off. */
  summary: string;
  /** `computed` verdicts follow the findings as their statuses change. */
  source?: 'agent' | 'computed';
}

export interface ReviewStats {
  files: number;
  additions: number;
  deletions: number;
}

export type ReviewSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface ReviewRisk {
  id: string;
  title: string;
  chapterId?: string;
  severity: ReviewSeverity;
}

export interface ReviewChapterFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface ReviewChapter {
  id: string;
  /** 1-based reading order. */
  index: number;
  title: string;
  summary: string;
  files: ReviewChapterFile[];
}

export type ReviewFindingStatus = 'open' | 'accepted' | 'dismissed' | 'fix-requested' | 'fixed';

export interface ReviewFindingWorkItem {
  id: string;
  title?: string;
  url?: string;
}

export interface ReviewFinding {
  id: string;
  severity: ReviewSeverity;
  category: string;
  /** One-line claim. */
  title: string;
  rationale: string;
  filePath: string;
  /** New-side (post-change) line numbers; old-side for deleted files. */
  lineStart: number;
  lineEnd: number;
  suggestion?: string;
  /** Unified diff the user can apply from the surface. */
  suggestedPatch?: string;
  status: ReviewFindingStatus;
  dismissReason?: string;
  /** Surface (or turn) whose diff fixed this finding. */
  fixedInSurfaceId?: string;
  /** Short note on how it was fixed ("Applied suggested patch", agent summary…). */
  fixNote?: string;
  chapterId?: string;
  prCommentUrl?: string;
  workItem?: ReviewFindingWorkItem;
}

export interface ReviewHunk {
  /** `@@ -a,b +c,d @@ section` */
  header: string;
  /** Raw diff lines including their ` `, `+`, `-` or `\` prefix. */
  lines: string[];
}

export type ReviewFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ReviewFileStat {
  path: string;
  previousPath?: string;
  status: ReviewFileStatus;
  additions: number;
  deletions: number;
}

export interface ReviewPullRequestComment {
  url?: string;
  postedAt: string;
  findingIds: string[];
}

export interface ReviewSurfaceData {
  scope: ReviewScope;
  verdict: ReviewVerdict;
  stats: ReviewStats;
  risks: ReviewRisk[];
  chapters: ReviewChapter[];
  findings: ReviewFinding[];
  /** Every changed file in scope (file tree order). */
  files: ReviewFileStat[];
  /** Hunks around findings, keyed by repo-relative path. */
  hunks: Record<string, ReviewHunk[]>;
  /** Complete diff, present when it fits the payload budget. */
  fullDiff?: Record<string, ReviewHunk[]>;
  /** Set when the full diff was too large to embed. */
  fullDiffOmitted?: boolean;
  /** Plain-language caveats about how the scope was resolved. */
  notes?: string[];
  prComments?: ReviewPullRequestComment[];
}

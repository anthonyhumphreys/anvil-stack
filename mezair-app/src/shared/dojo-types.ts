export type DojoOutcome = 'completed' | 'failed' | 'interrupted' | 'unfinished' | 'unknown';
export interface DojoTokenUsage {
  input: number;
  cachedInput: number;
  output: number;
}
export interface DojoPrice {
  provider: string;
  model: string;
  input: number;
  cachedInput: number;
  output: number;
  updatedAt: string;
}
export interface DojoRun {
  id: string;
  threadId: string;
  title: string;
  provider: string;
  model: string;
  role: string;
  workItem: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  outcome: DojoOutcome;
  userMessages: number;
  corrections: number;
  estimatedTokens: number;
  usage: DojoTokenUsage | null;
  cost: number | null;
  pricedUsageCount: number;
  usageCount: number;
  failures: Array<{ label: string; timestamp: string }>;
  retries: number;
  tools: number;
  goalsCompleted: number;
  contextCompactions: number;
  contextPercent: number | null;
  agents: Array<{
    id: string;
    label: string;
    model: string;
    status: string;
    startedAt: string;
    endedAt: string | null;
  }>;
}
export interface DojoPeriod {
  runs: number;
  completed: number;
  failed: number;
  interrupted: number;
  unfinished: number;
  unknown: number;
  medianMs: number | null;
  p90Ms: number | null;
  correctionRate: number | null;
  userMessages: number;
  corrections: number;
  measuredRuns: number;
  tokens: number;
  estimatedTokens: number;
  cost: number | null;
  pricedRuns: number;
  retries: number;
  toolFailures: number;
}
export interface DojoAnalytics {
  workspaceId: string;
  deliveries: Array<{ workItem: string; completedAt: string }>;
  windowStart: string;
  windowEnd: string;
  timezone: string;
  current: DojoPeriod;
  previous: DojoPeriod;
  runs: DojoRun[];
  days: Array<{
    date: string;
    runs: number;
    completed: number;
    failed: number;
    tokens: number;
    corrections: number;
    userMessages: number;
    durationMs: number | null;
    cost: number | null;
  }>;
  prices: DojoPrice[];
  followThrough: DojoRecommendationState[];
  reviews: { completed: number; failed: number; running: number; latestError: string | null };
}
export type DojoRecommendationStatus = 'suggested' | 'accepted' | 'applied' | 'dismissed';
export interface DojoRecommendationState {
  reportId: string;
  key: string;
  status: DojoRecommendationStatus;
  updatedAt: string;
  appliedAt: string | null;
}
export interface DojoCraftedSkill {
  name: string;
  description: string;
  reason: string;
  instructions: string;
  evidenceIds: string[];
  evidenceThreads?: Array<{ messageId: string; threadId: string }>;
}

export const AGENT_UI_PROTOCOL_VERSION = 1 as const;

export type AgentUIIntentKind = 'plan' | 'question';
export type AgentUIIntentLifecycle = 'pending' | 'presented' | 'resolved' | 'dismissed' | 'expired';

export interface AgentUIIntentScope {
  workspaceId?: string;
  threadId: string;
  runId?: string;
  providerThreadId?: string;
}

export interface AgentUIIntentPresentation {
  collapsed: boolean;
  hidden: boolean;
}

export interface AgentUIIntentBase<TKind extends AgentUIIntentKind, TPayload> {
  protocolVersion: typeof AGENT_UI_PROTOCOL_VERSION;
  id: string;
  kind: TKind;
  revision: number;
  scope: AgentUIIntentScope;
  lifecycle: AgentUIIntentLifecycle;
  presentation: AgentUIIntentPresentation;
  payload: TPayload;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export type AgentUIPlanStepStatus = 'todo' | 'in_progress' | 'blocked' | 'done';
export type AgentUIPlanLifecycle = 'active' | 'completed' | 'archived';

export interface AgentUIReference {
  id: string;
  kind: 'artifact' | 'file' | 'diff';
  label: string;
  path?: string;
  artifactId?: string;
  diff?: string;
}

export interface AgentUIPlanPhase {
  id: string;
  title: string;
  description?: string;
  collapsed?: boolean;
}

export interface AgentUIPlanStep {
  id: string;
  phaseId?: string;
  title: string;
  status: AgentUIPlanStepStatus;
  dependsOn?: string[];
  owner?: string;
  notes?: string;
  links?: AgentUIReference[];
}

export interface AgentUIPlanPayload {
  planId: string;
  title: string;
  description?: string;
  lifecycle: AgentUIPlanLifecycle;
  phases: AgentUIPlanPhase[];
  steps: AgentUIPlanStep[];
}

export type AgentUIPlanIntent = AgentUIIntentBase<'plan', AgentUIPlanPayload>;

export interface AgentUIQuestionOption {
  id: string;
  label: string;
  value: string;
  description?: string;
  consequences?: string;
  recommended?: boolean;
}

export type AgentUIQuestionKind =
  | 'single_choice'
  | 'multiple_choice'
  | 'yes_no'
  | 'free_text'
  | 'approval';

export interface AgentUIQuestion {
  id: string;
  kind: AgentUIQuestionKind;
  question: string;
  context?: string;
  required: boolean;
  allowCancel: boolean;
  sensitive?: boolean;
  defaultValue?: string | string[] | boolean;
  options?: AgentUIQuestionOption[];
}

export interface AgentUIQuestionPayload {
  title?: string;
  questions: AgentUIQuestion[];
}

export type AgentUIQuestionIntent = AgentUIIntentBase<'question', AgentUIQuestionPayload>;
export type AgentUIIntent = AgentUIPlanIntent | AgentUIQuestionIntent;

export type AgentUIAnswerValue = string | string[] | boolean | null;

export interface AgentUIQuestionResolution {
  intentId: string;
  action: 'submit' | 'skip' | 'cancel';
  answers: Record<string, AgentUIAnswerValue>;
  answeredAt: string;
}

export type AgentUIPlanPatchOperation =
  | { type: 'set_plan_metadata'; title?: string; description?: string }
  | { type: 'add_phase'; phase: AgentUIPlanPhase; index?: number }
  | { type: 'update_phase'; phaseId: string; changes: Partial<Omit<AgentUIPlanPhase, 'id'>> }
  | { type: 'remove_phase'; phaseId: string }
  | { type: 'add_step'; step: AgentUIPlanStep; index?: number }
  | { type: 'update_step'; stepId: string; changes: Partial<Omit<AgentUIPlanStep, 'id'>> }
  | { type: 'move_step'; stepId: string; index: number; phaseId?: string }
  | { type: 'remove_step'; stepId: string }
  | { type: 'set_step_status'; stepId: string; status: AgentUIPlanStepStatus }
  | { type: 'archive_plan' };

export interface AgentUIPlanPatch {
  planId: string;
  baseRevision: number;
  operationId: string;
  actor: 'agent' | 'user';
  operations: AgentUIPlanPatchOperation[];
}

export interface AgentUIIntentPresentationPatch {
  collapsed?: boolean;
  hidden?: boolean;
}

export interface AgentUIIntentBinding {
  provider: string;
  sessionId?: string;
  requestId?: string | number;
  responseKind?: 'user_input' | 'mcp_elicitation';
}

export interface AgentUIIntentRecord {
  intent: AgentUIIntent;
  binding?: AgentUIIntentBinding;
}

export interface AgentUIIntentValidationResult {
  ok: boolean;
  errors: string[];
}

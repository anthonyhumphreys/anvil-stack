import type { WorkItemProvider } from './types.js';

// ---------------------------------------------------------------------------
// Lifecycle Stages & Gates
// ---------------------------------------------------------------------------

export type LifecycleStage = 'ideation' | 'discovery_design' | 'build' | 'run';

export const GATE_IDS = ['gate_1', 'gate_2', 'gate_3', 'gate_4'] as const;

export type GateId = (typeof GATE_IDS)[number];

export function getGateFallbackLabel(gate: GateId): string {
  const index = GATE_IDS.indexOf(gate);
  return index >= 0 ? `Gate ${index + 1}` : gate;
}

export type GateCriterionType =
  | 'security_audit'
  | 'code_review'
  | 'adr_exists'
  | 'compliance_doc'
  | 'confluence_page'
  | 'governance_document'
  | 'impact_analysis'
  | 'architecture_diagram'
  | 'handover_pack'
  | 'manual_approval';

// ---------------------------------------------------------------------------
// Lifecycle Item
// ---------------------------------------------------------------------------

export interface LifecycleItem {
  id: string;
  workspaceId: string;
  title: string;
  description?: string;
  stage: LifecycleStage;
  linkedWorkItemId?: string;
  linkedWorkItemProvider?: WorkItemProvider;
  linkedRepoIds: string[];
  changeClassification?: 'major' | 'minor' | 'standard';
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Gate Templates
// ---------------------------------------------------------------------------

export interface GateCriterion {
  id: string;
  type: GateCriterionType;
  label: string;
  required: boolean;
  config?: Record<string, unknown>;
}

export interface GateTemplate {
  id: string;
  workspaceId: string;
  gate: GateId;
  label: string;
  criteria: GateCriterion[];
}

export interface GateTemplateUpdate {
  label: string;
  criteria: GateCriterion[];
}

// ---------------------------------------------------------------------------
// Gate Decisions
// ---------------------------------------------------------------------------

export type GateDecisionOutcome = 'approved' | 'approved_with_conditions' | 'deferred' | 'rejected';

export interface GateDecision {
  id: string;
  lifecycleItemId: string;
  gate: GateId;
  decision: GateDecisionOutcome;
  decidedBy: string;
  conditions?: string;
  rationale?: string;
  decidedAt: string;
}

// ---------------------------------------------------------------------------
// Impact Analysis
// ---------------------------------------------------------------------------

export interface AffectedModule {
  modulePath: string;
  modulePurpose: string;
  impactLevel: 'high' | 'medium' | 'low';
  impactDescription: string;
  affectedFiles: string[];
  downstreamDependents: string[];
}

export type ImpactAnalysisScopeType = 'manual' | 'branch_diff' | 'commit_range';

export interface ImpactAnalysis {
  id: string;
  lifecycleItemId: string;
  scopeType: ImpactAnalysisScopeType;
  scopeRef?: string;
  status: 'running' | 'completed' | 'failed';
  executiveSummary?: string;
  riskRating?: 'high' | 'medium' | 'low';
  affectedModules: AffectedModule[];
  technologyChanges: string[];
  crossCuttingConcerns: string[];
  technicalAppendix?: string;
  startedAt: string;
  completedAt?: string;
}

// ---------------------------------------------------------------------------
// Handover Pack
// ---------------------------------------------------------------------------

export interface HandoverSection {
  name: string;
  sourceType: string;
  included: boolean;
  fileName: string;
}

export interface HandoverPack {
  id: string;
  lifecycleItemId: string;
  generatedAt: string;
  outputPath: string;
  sections: HandoverSection[];
}

// ---------------------------------------------------------------------------
// Gate Readiness (computed, not persisted)
// ---------------------------------------------------------------------------

export type ReadinessStatus = 'met' | 'partial' | 'not_met';
export type OverallReadiness = 'green' | 'amber' | 'red';

export interface CriterionResult {
  criterion: GateCriterion;
  status: ReadinessStatus;
  detail: string;
}

export interface GateReadinessResult {
  gate: GateId;
  overall: OverallReadiness;
  criteria: CriterionResult[];
}

// ---------------------------------------------------------------------------
// Progress events
// ---------------------------------------------------------------------------

export interface AnalysisProgress {
  lifecycleItemId: string;
  message: string;
  percent: number;
}

export interface HandoverProgress {
  lifecycleItemId: string;
  section: string;
  message: string;
  percent: number;
}

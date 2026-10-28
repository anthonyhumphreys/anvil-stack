import type {
  OrganizationSkillRecommendations,
  SkillRecommendationSource,
} from '../../cloud/contract/skill-recommendations.js';
export type {
  OrganizationSkillRecommendations,
  SkillRecommendationSource,
} from '../../cloud/contract/skill-recommendations.js';

export interface SkillRecommendationCatalog {
  /** Bound to the current backend and account; null while signed out. */
  scopeKey: string | null;
  sources: SkillRecommendationSource[];
  organizations: OrganizationSkillRecommendations[];
  warning?: string;
}

export interface SkillRecommendationSelection {
  sourceId: string;
  organizationId?: string;
  scopeKey: string | null;
}

export interface SkillCollectionInspection {
  commit: string;
  skills: Array<{ name: string; description: string; url: string }>;
}

export interface SaveSkillRecommendationsInput {
  organizationId: string;
  scopeKey: string;
  expectedVersion: number;
  sources: SkillRecommendationSource[];
}

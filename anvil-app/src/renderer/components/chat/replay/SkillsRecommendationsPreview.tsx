import { CodexRegistryView } from '../../settings/CodexRegistryView';
import { RECOMMENDED_SKILL_SOURCES } from '../../../../shared/config/skill-recommendations';
import type { SkillRecommendationCatalog } from '../../../../shared/skill-recommendations';

/** Synthetic bridge for visual verification; never imported by the release entry. */
export function installSkillsRecommendationsPreview() {
  let conflictNext = new URLSearchParams(window.location.search).has('skills-conflict');
  let catalog: SkillRecommendationCatalog = {
    scopeKey: 'synthetic-skills-preview',
    sources: RECOMMENDED_SKILL_SOURCES,
    organizations: [
      {
        organizationId: 'demo-org',
        name: 'Acme Engineering',
        canEdit: true,
        version: 0,
        sources: [],
      },
    ],
  };
  window.anvil.codexRegistry = {
    snapshot: async () => ({
      cli: {
        installed: true,
        version: 'Codex CLI · preview',
        codexHome: '~/.codex',
        configPaths: [],
        authConfigured: true,
      },
      skills: [],
      mcpServers: [],
      scannedSkillRoots: [],
      warnings: [],
      refreshedAt: new Date().toISOString(),
    }),
    recommendations: async () => structuredClone(catalog),
    inspectCollection: async () => ({
      commit: 'a'.repeat(40),
      skills: [
        {
          name: 'review-change',
          description: 'Synthetic preview: review a proposed change and the evidence behind it.',
          url: 'https://github.com/t3dotgg/tstack',
        },
        {
          name: 'prepare-pr',
          description: 'Synthetic preview: prepare a concise pull request for a reviewer.',
          url: 'https://github.com/t3dotgg/tstack',
        },
      ],
    }),
    installCollection: async () => ({
      success: true,
      command: 'Synthetic preview',
      output: 'Preview only. No skills were installed.',
    }),
    saveRecommendations: async (input) => {
      await new Promise((resolve) => window.setTimeout(resolve, 200));
      if (conflictNext) {
        conflictNext = false;
        catalog = {
          ...catalog,
          organizations: catalog.organizations.map((org) => ({
            ...org,
            version: org.version + 1,
            sources: [
              {
                id: 'shared',
                name: 'Shared team skills',
                description: 'Synthetic edit by another owner.',
                repository: 't3dotgg/tstack',
                path: 'skills',
              },
            ],
          })),
        };
        throw new Error('Another owner changed these recommendations (conflict).');
      }
      const org = catalog.organizations.find(
        (item) => item.organizationId === input.organizationId,
      );
      if (!org || org.version !== input.expectedVersion) throw new Error('conflict');
      catalog = {
        ...catalog,
        organizations: [{ ...org, version: org.version + 1, sources: input.sources }],
      };
    },
    searchSkills: async () => [],
    installSkill: async () => ({ success: false, command: 'Synthetic preview' }),
    registerMcp: async () => ({ success: false, command: 'Synthetic preview' }),
  };
}

export function SkillsRecommendationsPreview() {
  return (
    <div className="h-screen bg-bg-primary text-text-primary">
      <CodexRegistryView />
    </div>
  );
}

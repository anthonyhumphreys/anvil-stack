import type { SkillRecommendationSource } from '../../../cloud/contract/skill-recommendations.js';

/**
 * Anvil's editorial catalogue. Order is display order. Add trusted repositories here;
 * their SKILL.md files are discovered at runtime. No install runs when browsing.
 * Organisation owners maintain their own catalogue using the same shape.
 */
export const RECOMMENDED_SKILL_SOURCES = [
  {
    id: 'theo',
    name: "Theo's skills",
    description:
      'Theo’s everyday workflows for reviewing changes, preparing PRs and seeing them through.',
    repository: 't3dotgg/tstack',
    path: 'skills',
  },
  {
    id: 'poteto',
    name: "poteto's skills",
    description:
      'Lauren Tan’s pstack collection for understanding code, designing changes and verifying work. Some workflows use Cursor-specific tools.',
    repository: 'cursor/plugins',
    path: 'pstack/skills',
  },
  {
    id: 'matt-pocock',
    name: "Matt Pocock's skills",
    description:
      'Composable engineering skills for planning, implementation and working through a codebase.',
    repository: 'mattpocock/skills',
    path: 'skills',
  },
] satisfies SkillRecommendationSource[];

import type { RepoInfo, UserRole } from '../../shared/types';
import { repoIsMapped } from '../contexts/WorkspaceContext';

export interface StarterPrompt {
  /** Short chip label for the empty state. */
  label: string;
  /** Full prompt text prefilled into the composer. */
  prompt: string;
}

export interface StarterPromptInput {
  repos: RepoInfo[];
  userRole?: UserRole | null;
  /** Cap on how many prompts to return (Chat empty state shows 3–4). */
  limit?: number;
}

const GENERIC_PROMPTS: readonly StarterPrompt[] = [
  {
    label: 'What can you do?',
    prompt: 'What can you help me with in this workspace?',
  },
];

const ROLE_PROMPTS: Partial<Record<UserRole, readonly StarterPrompt[]>> = {
  developer: [],
  'ba-brm': [
    {
      label: 'Draft requirements',
      prompt: 'Help me draft user stories for a new feature in this workspace.',
    },
  ],
  design: [
    {
      label: 'Design review',
      prompt: 'Walk me through how to run a design review against this workspace.',
    },
  ],
  itsm: [
    {
      label: 'Investigate an incident',
      prompt: 'Help me investigate an incident affecting this workspace.',
    },
  ],
};

/**
 * C2/3.5: role-aware starter prompts for the Chat empty state.
 *
 * Chat is enabled before indexing finishes, so prompts are honest about repo
 * readiness — repo-scoped prompts name a mapped repo; before the first repo is
 * mapped the suggestions stay workspace-level rather than promising context
 * that isn't there yet.
 */
export function getStarterPrompts({
  repos,
  userRole,
  limit = 4,
}: StarterPromptInput): StarterPrompt[] {
  const prompts: StarterPrompt[] = [...(ROLE_PROMPTS[userRole ?? 'developer'] ?? [])];

  const mapped = repos.find(repoIsMapped);
  if (mapped) {
    prompts.push(
      {
        label: `Explain ${mapped.name}`,
        prompt: `Give me an overview of the ${mapped.name} repository — what it does, how it's organised, and the main entry points.`,
      },
      {
        label: 'Find where something lives',
        prompt: `Where in ${mapped.name} is the code that handles `,
      },
    );
  } else if (repos.length > 0) {
    prompts.push({
      label: 'Explain this codebase',
      prompt: `Give me an overview of the ${repos[0].name} repository.`,
    });
  }

  prompts.push(...GENERIC_PROMPTS);
  return prompts.slice(0, limit);
}

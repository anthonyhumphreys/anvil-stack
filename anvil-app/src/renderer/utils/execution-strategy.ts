export type ExecutionStrategy = 'focused' | 'adaptive' | 'parallel' | 'review-team';

export const EXECUTION_STRATEGIES: Array<{
  id: ExecutionStrategy;
  label: string;
  description: string;
}> = [
  {
    id: 'focused',
    label: 'Focused',
    description: 'Keep tightly coupled work with one primary agent.',
  },
  {
    id: 'adaptive',
    label: 'Adaptive',
    description: 'Delegate independent work when it materially helps.',
  },
  {
    id: 'parallel',
    label: 'Parallel',
    description: 'Actively split independent investigation and implementation work.',
  },
  {
    id: 'review-team',
    label: 'Review team',
    description: 'Use independent implementation and verification passes.',
  },
];

export function buildExecutionStrategyPrompt(strategy: ExecutionStrategy): string | null {
  if (strategy === 'focused') return null;

  const instructions: Record<Exclude<ExecutionStrategy, 'focused'>, string> = {
    adaptive:
      'Use subagents for concrete, bounded tasks when parallel work would materially improve speed or confidence. Keep tightly coupled work with the primary agent and consolidate delegated results before finishing.',
    parallel:
      'Actively identify independent investigation, implementation, and verification tasks that can run in parallel. Use subagents for those bounded tasks, keep coupled edits coordinated by the primary agent, and consolidate all results before finishing.',
    'review-team':
      'Use subagents to separate implementation from independent review and verification where the task permits. Resolve review findings and consolidate the evidence before finishing.',
  };

  return ['[Execution strategy]', instructions[strategy]].join('\n');
}

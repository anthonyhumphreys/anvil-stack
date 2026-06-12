import type { LifecycleStage, LifecycleStageDefinition } from '../../../../shared/types';

const STAGE_BADGE_CLASSES = [
  'bg-blue-500/10 text-blue-400',
  'bg-purple-500/10 text-purple-400',
  'bg-amber-500/10 text-amber-400',
  'bg-emerald-500/10 text-emerald-400',
  'bg-cyan-500/10 text-cyan-400',
  'bg-rose-500/10 text-rose-400',
];

const STAGE_DOT_CLASSES = [
  'bg-blue-500',
  'bg-purple-500',
  'bg-amber-500',
  'bg-emerald-500',
  'bg-cyan-500',
  'bg-rose-500',
];

export function stageLabel(stageId: LifecycleStage, stages: LifecycleStageDefinition[]): string {
  return stages.find((stage) => stage.id === stageId)?.label ?? humanizeStageId(stageId);
}

export function stageBadgeClass(
  stageId: LifecycleStage,
  stages: LifecycleStageDefinition[],
): string {
  const index = Math.max(
    0,
    stages.findIndex((stage) => stage.id === stageId),
  );

  return STAGE_BADGE_CLASSES[index % STAGE_BADGE_CLASSES.length];
}

export function stageDotClass(stageId: LifecycleStage, stages: LifecycleStageDefinition[]): string {
  const index = Math.max(
    0,
    stages.findIndex((stage) => stage.id === stageId),
  );

  return STAGE_DOT_CLASSES[index % STAGE_DOT_CLASSES.length];
}

function humanizeStageId(stageId: string): string {
  return stageId
    .split('_')
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

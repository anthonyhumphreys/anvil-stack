import type { AgentUIIntent } from '../../shared/agent-ui-intents';

/** Picks the newer copy of the same intent: higher revision wins, then the later update. */
export function newerIntent<T extends AgentUIIntent>(current: T, incoming: T): T {
  if (incoming.revision !== current.revision) {
    return incoming.revision > current.revision ? incoming : current;
  }
  return Date.parse(incoming.updatedAt) >= Date.parse(current.updatedAt) ? incoming : current;
}

/** Whether `incoming` should replace a stored copy of the same intent. */
export function shouldReplaceIntent(current: AgentUIIntent, incoming: AgentUIIntent): boolean {
  return newerIntent(current, incoming) === incoming;
}

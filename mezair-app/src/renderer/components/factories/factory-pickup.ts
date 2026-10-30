import type { FactoryRun, FactoryRunControlInput } from '../../../shared/factories';

export function takeoverControlInput(
  runId: string,
  context: NonNullable<FactoryRunControlInput['takeoverContext']>,
): FactoryRunControlInput {
  return { runId, action: 'takeover', takeoverContext: { ...context } };
}

/** A pending claim is not a local chat; only navigate after the recipient-local thread is returned. */
export function recipientPickupThread(run: Pick<FactoryRun, 'takeoverThreadId'>): string | null {
  return run.takeoverThreadId || null;
}

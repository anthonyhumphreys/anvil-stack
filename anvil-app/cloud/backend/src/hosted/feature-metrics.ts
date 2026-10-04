import { OPERATIONS, type OperationName } from '../../../contract/operations';
import { emitMetric } from './metrics';

const BROKER_OPERATIONS = [
  'machine.discover',
  'machine.allocate',
  'machine.release',
  'machine.ticket.issue',
  'machine.ticket.consume',
  'machine.trust.refresh',
] as const;

export type UsageOperation = OperationName | (typeof BROKER_OPERATIONS)[number];
const KNOWN_OPERATIONS: ReadonlySet<string> = new Set([...OPERATIONS, ...BROKER_OPERATIONS]);
export const FEATURE_USAGE_SAMPLE_RATE = 0.01;

export interface FeatureUsage {
  operation: UsageOperation;
  status: number;
  /** Request wall time, including waits. This is not billed Worker CPU or DO duration. */
  wallMs: number;
  requestBytes?: number;
  responseBytes?: number;
  batchItems?: number;
}

function boundedCount(value: number | undefined, maximum: number): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.min(maximum, Math.round(value))
    : undefined;
}

/** Sampled attribution only. Never writes durable counters or includes tenant identifiers. */
export function emitFeatureUsage(usage: FeatureUsage, sample = Math.random()): void {
  if (
    !Number.isFinite(sample) ||
    sample < 0 ||
    sample >= FEATURE_USAGE_SAMPLE_RATE ||
    !KNOWN_OPERATIONS.has(usage.operation) ||
    !Number.isInteger(usage.status) ||
    usage.status < 100 ||
    usage.status > 599
  ) {
    return;
  }
  emitMetric('feature.usage', {
    operation: usage.operation,
    status: usage.status,
    sampleRate: FEATURE_USAGE_SAMPLE_RATE,
    wallMs: boundedCount(usage.wallMs, 300_000),
    requestBytes: boundedCount(usage.requestBytes, 1_073_741_824),
    responseBytes: boundedCount(usage.responseBytes, 1_073_741_824),
    batchItems: boundedCount(usage.batchItems, 10_000),
  });
}

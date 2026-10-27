export type TraceKind = "agent" | "workflow";

export type TraceStatus = "running" | "completed" | "failed";

export type TraceEventType =
  | "agent.invoke.started"
  | "agent.invoke.completed"
  | "agent.invoke.failed"
  | "agent.model.completed"
  | "agent.tool.approval"
  | "agent.tool.completed"
  | "agent.tool.failed"
  | "workflow.started"
  | "workflow.step.started"
  | "workflow.step.completed"
  | "workflow.step.failed"
  | "workflow.completed"
  | "workflow.failed";

export type TraceEvent = {
  eventId: string;
  traceId: string;
  timestamp: string;
  type: TraceEventType;
  name: string;
  status?: TraceStatus;
  durationMs?: number;
  attributes?: Record<string, unknown>;
};

export type TraceRecord = {
  traceId: string;
  kind: TraceKind;
  name: string;
  subjectId: string;
  status: TraceStatus;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  events: TraceEvent[];
};

export type TraceStartInput = {
  traceId: string;
  kind: TraceKind;
  name: string;
  subjectId: string;
  startedAt?: string;
  attributes?: Record<string, unknown>;
};

export type TraceEventInput = Omit<
  TraceEvent,
  "eventId" | "traceId" | "timestamp"
> & {
  eventId?: string;
  timestamp?: string;
};

export type TraceCompleteInput = {
  status: TraceStatus;
  completedAt?: string;
  attributes?: Record<string, unknown>;
};

export type TraceRedactor = (value: unknown) => unknown;

export interface TraceAdapter {
  start(input: TraceStartInput): Promise<TraceRecord>;
  event(traceId: string, input: TraceEventInput): Promise<void>;
  complete(traceId: string, input: TraceCompleteInput): Promise<void>;
  get(traceId: string): Promise<TraceRecord | null>;
  list(): Promise<TraceRecord[]>;
}

const sensitiveKeyPattern =
  /(^|[_-])(authorization|cookie|password|secret|token|api[_-]?key|access[_-]?key)([_-]|$)/i;

export function redactTraceValue(value: unknown): unknown {
  return redactTraceNode(value, new WeakSet<object>());
}

function redactTraceNode(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }

    seen.add(value);
    return value.map((item) => redactTraceNode(item, seen));
  }

  if (value instanceof Uint8Array) {
    return `[bytes:${value.byteLength}]`;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    };
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  seen.add(value);

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      sensitiveKeyPattern.test(key)
        ? "[redacted]"
        : redactTraceNode(child, seen),
    ]),
  );
}

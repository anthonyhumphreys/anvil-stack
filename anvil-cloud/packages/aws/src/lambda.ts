import { randomUUID } from "node:crypto";

import {
  createRuntimeContext,
  handleRuntimeRequest,
  RuntimeError,
  type AppDefinition,
  type RuntimeHost,
  type RuntimeResponse,
  type WorkflowState,
} from "@anvil-cloud/runtime";

import {
  createAwsRuntimeHandler,
  type AwsHttpEvent,
  type AwsHttpResponse,
} from "./http.js";

export type AwsSqsEvent = {
  Records: Array<{
    messageId?: string;
    body: string;
    eventSource?: string;
  }>;
};

export type AwsScheduledJobEvent = {
  id?: string;
  source?: string;
  detail?: {
    name?: unknown;
    payload?: unknown;
  };
};

export type AwsWorkflowStepEvent = {
  source?: string;
  detail?: {
    workflow?: unknown;
    step?: unknown;
    runId?: unknown;
    input?: unknown;
    steps?: unknown;
  };
};

export type AwsWorkflowStepResult = {
  workflow: string;
  step: string;
  runId: string;
  input: unknown;
  steps: Record<string, unknown>;
  result: unknown;
};

export type AwsLambdaRuntimeEvent =
  | AwsHttpEvent
  | AwsSqsEvent
  | AwsScheduledJobEvent
  | AwsWorkflowStepEvent;

export type AwsLambdaRuntimeResult =
  | AwsHttpResponse
  | AwsWorkflowStepResult
  | {
      batchItemFailures: Array<{ itemIdentifier: string }>;
    }
  | void;

export type AwsLambdaRuntimeHandler = (
  event: AwsLambdaRuntimeEvent,
) => Promise<AwsLambdaRuntimeResult>;

export function createAwsLambdaRuntimeHandler(
  app: AppDefinition,
  host: RuntimeHost,
): AwsLambdaRuntimeHandler {
  installOutboundFetchPolicy(process.env.ANVIL_OUTBOUND_FETCH_ALLOW);
  const httpHandler = createAwsRuntimeHandler(app, host, {
    allowBodyIdentity: process.env.ANVIL_AUTH_ALLOW_BODY_IDENTITY === "true",
  });

  return async (event) => {
    if (isSqsEvent(event)) {
      return handleSqsEvent(app, host, event);
    }

    if (isScheduledJobEvent(event)) {
      await runJob(app, host, {
        name: event.detail.name,
        payload: event.detail.payload,
        requestId: event.id ?? randomUUID(),
      });
      return;
    }

    if (isWorkflowStepEvent(event)) {
      return runWorkflowStep(app, host, event.detail);
    }

    return httpHandler(event as AwsHttpEvent);
  };
}

export function installOutboundFetchPolicy(rawAllowList: string | undefined) {
  const allowList = parseOutboundFetchAllowList(rawAllowList);
  const currentFetch = globalThis.fetch as
    | (typeof fetch & { __anvilOriginalFetch?: typeof fetch })
    | undefined;

  if (allowList.length === 0) {
    if (currentFetch?.__anvilOriginalFetch) {
      globalThis.fetch = currentFetch.__anvilOriginalFetch;
    }
    return;
  }

  const originalFetch = currentFetch?.__anvilOriginalFetch ?? currentFetch;

  if (!originalFetch) {
    return;
  }

  const allowedHosts = new Set(allowList);

  const guardedFetch = (async (input, init) => {
    const host = hostForFetchInput(input);

    if (!host || !allowedHosts.has(host)) {
      throw new RuntimeError(
        "OUTBOUND_FETCH_NOT_ALLOWED",
        host
          ? `Fetch host '${host}' is not declared in capabilities.outboundFetch.allow.`
          : "Fetch target could not be resolved against capabilities.outboundFetch.allow.",
        403,
        {
          host,
          allowedHosts: Array.from(allowedHosts).sort(),
        },
      );
    }

    return originalFetch(input, init);
  }) as typeof fetch & { __anvilOriginalFetch?: typeof fetch };

  guardedFetch.__anvilOriginalFetch = originalFetch;
  globalThis.fetch = guardedFetch;
}

function parseOutboundFetchAllowList(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
}

function hostForFetchInput(input: Parameters<typeof fetch>[0]): string | null {
  try {
    if (typeof input === "string" || input instanceof URL) {
      return new URL(input).host;
    }

    return new URL(input.url).host;
  } catch {
    return null;
  }
}

async function runWorkflowStep(
  app: AppDefinition,
  host: RuntimeHost,
  detail: {
    workflow: unknown;
    step: unknown;
    runId: unknown;
    input?: unknown;
    steps?: unknown;
  },
): Promise<AwsWorkflowStepResult> {
  if (typeof detail.workflow !== "string" || detail.workflow.length === 0) {
    throw new Error("AWS workflow event is missing a string workflow name.");
  }

  if (typeof detail.step !== "string" || detail.step.length === 0) {
    throw new Error("AWS workflow event is missing a string step name.");
  }

  if (typeof detail.runId !== "string" || detail.runId.length === 0) {
    throw new Error("AWS workflow event is missing a string run id.");
  }

  const workflow = app.workflows?.[detail.workflow];

  if (!workflow) {
    throw new Error(`AWS workflow '${detail.workflow}' was not found.`);
  }

  const step = workflow.steps.find((candidate) => {
    return candidate.name === detail.step;
  });

  if (!step) {
    throw new Error(
      `AWS workflow '${detail.workflow}' step '${detail.step}' was not found.`,
    );
  }

  const priorSteps = isRecord(detail.steps) ? detail.steps : {};
  const state: WorkflowState = {
    input: detail.input,
    steps: priorSteps,
  };
  const ctx = await createRuntimeContext(
    host,
    {
      kind: "workflow",
      name: detail.workflow,
      input: detail.input,
      requestId: `${detail.runId}:${detail.step}`,
    },
    `${detail.workflow}.${detail.step}`,
  );
  const result = await Promise.resolve(step.handler(ctx, state));

  return {
    workflow: detail.workflow,
    step: detail.step,
    runId: detail.runId,
    input: detail.input,
    steps: {
      ...priorSteps,
      [detail.step]: result,
    },
    result,
  };
}

async function handleSqsEvent(
  app: AppDefinition,
  host: RuntimeHost,
  event: AwsSqsEvent,
): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> {
  const failures: Array<{ itemIdentifier: string }> = [];

  for (const record of event.Records) {
    try {
      const message = parseJobMessage(record.body);

      await runJob(app, host, {
        name: message.name,
        payload: message.payload,
        requestId: record.messageId ?? randomUUID(),
      });
    } catch {
      if (record.messageId) {
        failures.push({
          itemIdentifier: record.messageId,
        });
      } else {
        throw new Error("SQS job record failed without a message id.");
      }
    }
  }

  return { batchItemFailures: failures };
}

async function runJob(
  app: AppDefinition,
  host: RuntimeHost,
  input: {
    name: unknown;
    payload: unknown;
    requestId: string;
  },
): Promise<RuntimeResponse> {
  if (typeof input.name !== "string" || input.name.length === 0) {
    throw new Error("AWS job event is missing a string job name.");
  }

  const response = await handleRuntimeRequest(app, host, {
    kind: "job",
    name: input.name,
    payload: input.payload,
    requestId: input.requestId,
  });

  if (!response.ok) {
    throw new Error(
      response.error?.message ?? `AWS job '${input.name}' failed.`,
    );
  }

  return response;
}

function parseJobMessage(body: string): { name: unknown; payload: unknown } {
  const parsed = JSON.parse(body) as unknown;

  if (!isObject(parsed)) {
    throw new Error("SQS job message body must be a JSON object.");
  }

  return {
    name: parsed.name,
    payload: "payload" in parsed ? parsed.payload : null,
  };
}

function isSqsEvent(event: AwsLambdaRuntimeEvent): event is AwsSqsEvent {
  if (!isObject(event)) {
    return false;
  }

  const candidate = event as Record<string, unknown>;

  if (!Array.isArray(candidate.Records)) {
    return false;
  }

  return (candidate.Records as Array<Record<string, unknown>>).some(
    (record) => record.eventSource === "aws:sqs",
  );
}

function isScheduledJobEvent(
  event: AwsLambdaRuntimeEvent,
): event is AwsScheduledJobEvent & {
  detail: { name: unknown; payload?: unknown };
} {
  if (!isObject(event)) {
    return false;
  }

  const candidate = event as Record<string, unknown>;
  const detail = candidate.detail;

  return (
    candidate.source === "anvil.jobs" && isObject(detail) && "name" in detail
  );
}

function isWorkflowStepEvent(
  event: AwsLambdaRuntimeEvent,
): event is AwsWorkflowStepEvent & {
  detail: {
    workflow: unknown;
    step: unknown;
    runId: unknown;
    input?: unknown;
    steps?: unknown;
  };
} {
  if (!isObject(event)) {
    return false;
  }

  const candidate = event as Record<string, unknown>;
  const detail = candidate.detail;

  return (
    candidate.source === "anvil.workflows" &&
    isObject(detail) &&
    "workflow" in detail &&
    "step" in detail &&
    "runId" in detail
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isObject(value) && !Array.isArray(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

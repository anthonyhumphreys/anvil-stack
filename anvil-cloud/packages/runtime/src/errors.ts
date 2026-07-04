export type RuntimeErrorCode =
  | "VALIDATION_ERROR"
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "HANDLER_NOT_FOUND"
  | "CAPABILITY_NOT_DECLARED"
  | "OUTBOUND_FETCH_NOT_ALLOWED"
  | "ADAPTER_ERROR"
  | "INTERNAL_ERROR";

export type RuntimeErrorPayload = {
  code: RuntimeErrorCode;
  message: string;
  details?: unknown;
};

export type RuntimeDiagnostic = {
  code: string;
  message: string;
  severity: "error" | "warning";
  details?: unknown;
};

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(
    code: RuntimeErrorCode,
    message: string,
    status: number,
    details?: unknown,
  ) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
    this.status = status;
    this.details = details;
  }

  toPayload(): RuntimeErrorPayload {
    return this.details === undefined
      ? {
          code: this.code,
          message: this.message,
        }
      : {
          code: this.code,
          message: this.message,
          details: this.details,
        };
  }
}

export function handlerNotFound(kind: string, name: string): RuntimeError {
  return new RuntimeError(
    "HANDLER_NOT_FOUND",
    `No ${kind} handler named '${name}' is defined.`,
    404,
    { kind, name },
  );
}

export function normaliseRuntimeError(error: unknown): RuntimeError {
  if (error instanceof RuntimeError) {
    return error;
  }

  return new RuntimeError(
    "INTERNAL_ERROR",
    "Handler failed during runtime execution.",
    500,
  );
}

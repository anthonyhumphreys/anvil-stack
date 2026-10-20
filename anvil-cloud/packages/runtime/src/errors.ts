export type RuntimeErrorCode =
  | "VALIDATION_ERROR"
  | "CONFLICT"
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

const runtimeErrorCodes = new Set<RuntimeErrorCode>([
  "VALIDATION_ERROR",
  "CONFLICT",
  "AUTH_REQUIRED",
  "FORBIDDEN",
  "NOT_FOUND",
  "HANDLER_NOT_FOUND",
  "CAPABILITY_NOT_DECLARED",
  "OUTBOUND_FETCH_NOT_ALLOWED",
  "ADAPTER_ERROR",
  "INTERNAL_ERROR",
]);

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

  const foreign = readForeignRuntimeError(error);

  if (foreign) {
    // RuntimeErrors created by a separately bundled copy of the runtime cross
    // this boundary as ordinary Errors. Rebuild only the public fields that
    // belong to the RuntimeError contract; provider-specific `details` are
    // intentionally not copied.
    return new RuntimeError(foreign.code, foreign.message, foreign.status);
  }

  return new RuntimeError(
    "INTERNAL_ERROR",
    "Handler failed during runtime execution.",
    500,
  );
}

function readForeignRuntimeError(
  error: unknown,
): { code: RuntimeErrorCode; message: string; status: number } | null {
  try {
    if (!(error instanceof Error)) {
      return null;
    }

    const ownDataValue = (key: string): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(error, key);
      return descriptor && "value" in descriptor ? descriptor.value : undefined;
    };
    const name = ownDataValue("name");
    const code = ownDataValue("code");
    const message = ownDataValue("message");
    const status = ownDataValue("status");

    if (
      name !== "RuntimeError" ||
      typeof code !== "string" ||
      !runtimeErrorCodes.has(code as RuntimeErrorCode) ||
      typeof message !== "string" ||
      message.length === 0 ||
      message.length > 512 ||
      typeof status !== "number" ||
      !Number.isInteger(status) ||
      status < 400 ||
      status > 599
    ) {
      return null;
    }

    return { code: code as RuntimeErrorCode, message, status };
  } catch {
    // A malformed or proxied foreign error must keep the ordinary unexpected
    // error response instead of changing runtime behavior or leaking data.
    return null;
  }
}

import type { RuntimeDiagnostic, RuntimeErrorPayload } from "./errors.js";
import type { AuthIdentity } from "./host.js";

export type QueryRuntimeRequest = {
  kind: "query";
  name: string;
  input: unknown;
  auth: AuthIdentity | null;
  requestId: string;
};

export type MutationRuntimeRequest = {
  kind: "mutation";
  name: string;
  input: unknown;
  auth: AuthIdentity | null;
  requestId: string;
};

export type EndpointRuntimeRequest = {
  kind: "endpoint";
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
  auth: AuthIdentity | null;
  requestId: string;
};

export type JobRuntimeRequest = {
  kind: "job";
  name: string;
  payload: unknown;
  requestId: string;
};

export type RuntimeRequest =
  | QueryRuntimeRequest
  | MutationRuntimeRequest
  | EndpointRuntimeRequest
  | JobRuntimeRequest;

export type RuntimeResponse = {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body: unknown;
  error?: RuntimeErrorPayload;
  diagnostics?: RuntimeDiagnostic[];
};

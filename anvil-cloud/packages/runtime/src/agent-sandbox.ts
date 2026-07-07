import type { AgentCredentialBroker, AgentManifest } from "./agent.js";

export type AgentSandboxStatus =
  | "starting"
  | "active"
  | "waiting-for-approval"
  | "suspended"
  | "terminating"
  | "terminated"
  | "expired"
  | "failed";

export type AgentSandboxSession = {
  id: string;
  agent: string;
  status: AgentSandboxStatus;
  endpointUrl?: string;
  provider: string;
  region?: string;
  startedAt?: string;
  terminatedAt?: string;
  expiresAt?: string;
  image?: {
    arn: string;
    version?: string;
  };
  metadata: Record<string, unknown>;
};

export type AgentSandboxStartInput = {
  manifest: AgentManifest;
  cell: string;
  environment: string;
  workspace?: {
    id?: string;
    snapshot?: string;
  };
  credentialBroker?: AgentCredentialBroker;
  clientToken?: string;
};

export type AgentSandboxAuthToken = {
  sessionId: string;
  tokenParts: Record<string, string>;
};

export type AgentSandboxProvider = {
  readonly id: string;
  start(input: AgentSandboxStartInput): Promise<AgentSandboxSession>;
  inspect(sessionId: string): Promise<AgentSandboxSession>;
  suspend(sessionId: string): Promise<void>;
  resume(sessionId: string): Promise<AgentSandboxSession>;
  terminate(sessionId: string): Promise<void>;
  createAuthToken?(
    sessionId: string,
    options?: {
      expirationMinutes?: number;
      ports?: number[];
    },
  ): Promise<AgentSandboxAuthToken>;
};

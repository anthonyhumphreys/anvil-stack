import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentExecutionEvent } from "@anvil-cloud/runtime";

import type { AgentExecutionLease } from "./execution.js";

export interface AgentExecutionStore {
  get(executionId: string): Promise<AgentExecutionLease | null>;
  findByClientToken(clientToken: string): Promise<AgentExecutionLease | null>;
  list(): Promise<AgentExecutionLease[]>;
  put(lease: AgentExecutionLease): Promise<void>;
  appendEvents(
    executionId: string,
    events: AgentExecutionEvent[],
  ): Promise<void>;
  events(
    executionId: string,
    afterSequence?: number,
  ): Promise<AgentExecutionEvent[]>;
}

type ExecutionStoreState = {
  schemaVersion: "0.1";
  leases: Record<string, AgentExecutionLease>;
  events: Record<string, AgentExecutionEvent[]>;
};

export class InMemoryAgentExecutionStore implements AgentExecutionStore {
  private readonly state: ExecutionStoreState = emptyState();

  async get(executionId: string): Promise<AgentExecutionLease | null> {
    return clone(this.state.leases[executionId] ?? null);
  }

  async findByClientToken(
    clientToken: string,
  ): Promise<AgentExecutionLease | null> {
    const lease = Object.values(this.state.leases).find(
      (candidate) => candidate.request.clientToken === clientToken,
    );

    return clone(lease ?? null);
  }

  async list(): Promise<AgentExecutionLease[]> {
    return clone(
      Object.values(this.state.leases).sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      ),
    );
  }

  async put(lease: AgentExecutionLease): Promise<void> {
    this.state.leases[lease.id] = clone(lease);
  }

  async appendEvents(
    executionId: string,
    events: AgentExecutionEvent[],
  ): Promise<void> {
    this.state.events[executionId] = [
      ...(this.state.events[executionId] ?? []),
      ...clone(events),
    ];
  }

  async events(
    executionId: string,
    afterSequence = 0,
  ): Promise<AgentExecutionEvent[]> {
    return clone(
      (this.state.events[executionId] ?? []).filter(
        (event) => event.sequence > afterSequence,
      ),
    );
  }
}

export class JsonFileAgentExecutionStore implements AgentExecutionStore {
  constructor(readonly filePath: string) {}

  async get(executionId: string): Promise<AgentExecutionLease | null> {
    const state = await this.read();

    return clone(state.leases[executionId] ?? null);
  }

  async findByClientToken(
    clientToken: string,
  ): Promise<AgentExecutionLease | null> {
    const state = await this.read();
    const lease = Object.values(state.leases).find(
      (candidate) => candidate.request.clientToken === clientToken,
    );

    return clone(lease ?? null);
  }

  async list(): Promise<AgentExecutionLease[]> {
    const state = await this.read();

    return clone(
      Object.values(state.leases).sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      ),
    );
  }

  async put(lease: AgentExecutionLease): Promise<void> {
    const state = await this.read();
    state.leases[lease.id] = clone(lease);
    await this.write(state);
  }

  async appendEvents(
    executionId: string,
    events: AgentExecutionEvent[],
  ): Promise<void> {
    const state = await this.read();
    state.events[executionId] = [
      ...(state.events[executionId] ?? []),
      ...clone(events),
    ];
    await this.write(state);
  }

  async events(
    executionId: string,
    afterSequence = 0,
  ): Promise<AgentExecutionEvent[]> {
    const state = await this.read();

    return clone(
      (state.events[executionId] ?? []).filter(
        (event) => event.sequence > afterSequence,
      ),
    );
  }

  private async read(): Promise<ExecutionStoreState> {
    try {
      const parsed = JSON.parse(
        await readFile(this.filePath, "utf8"),
      ) as unknown;

      if (!isStoreState(parsed)) {
        throw new Error(`Invalid execution store at ${this.filePath}.`);
      }

      return parsed;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return emptyState();
      }

      throw error;
    }
  }

  private async write(state: ExecutionStoreState): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, this.filePath);
  }
}

function emptyState(): ExecutionStoreState {
  return {
    schemaVersion: "0.1",
    leases: {},
    events: {},
  };
}

function isStoreState(value: unknown): value is ExecutionStoreState {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { schemaVersion?: unknown }).schemaVersion === "0.1" &&
    typeof (value as { leases?: unknown }).leases === "object" &&
    typeof (value as { events?: unknown }).events === "object"
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

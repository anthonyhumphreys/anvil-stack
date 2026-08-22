import {
  RuntimeError,
  type DatabaseAdapter,
  type DatabaseQueryClient,
  type DatabaseTableClient,
  type DatabaseWhereOperator,
  type RuntimeHost,
} from "@anvil-cloud/runtime";

export type CloudflareWorkerBindings = Record<string, unknown> & {
  ANVIL_ASSETS?: {
    fetch(request: Request): Promise<Response>;
  };
};

export function createCloudflareRuntimeHost(
  bindings: CloudflareWorkerBindings,
): RuntimeHost {
  return {
    db: new UnsupportedDatabaseAdapter(),
    files: {
      get: () => unsupported("files"),
      put: () => unsupported("files"),
      delete: () => unsupported("files"),
    },
    env: {
      get(name) {
        const value = bindings[name];

        return typeof value === "string" ? value : undefined;
      },
    },
    auth: {
      current: async () => null,
    },
    logs: {
      async write(entry) {
        const output = JSON.stringify({ source: "anvil-cloud", ...entry });

        switch (entry.level) {
          case "debug":
            console.debug(output);
            break;
          case "error":
            console.error(output);
            break;
          case "warn":
            console.warn(output);
            break;
          case "info":
            console.info(output);
            break;
        }
      },
    },
    events: {
      publish: () => unsupported("events"),
    },
    jobs: {
      enqueue: () => unsupported("jobs"),
    },
    workflows: {
      start: () => unsupported("workflows"),
    },
  };
}

class UnsupportedDatabaseAdapter implements DatabaseAdapter {
  table(name: string): DatabaseTableClient {
    const fail = <T>(): Promise<T> => unsupported(`database table '${name}'`);
    const query = (): DatabaseQueryClient => ({
      all: fail,
      first: fail,
      count: fail,
    });

    return {
      all: fail,
      get: fail,
      insert: fail,
      update: fail,
      delete: fail,
      where(_field: string, _operator: DatabaseWhereOperator, _value: unknown) {
        return query();
      },
    };
  }
}

function unsupported<T>(capability: string): Promise<T> {
  return Promise.reject(
    new RuntimeError(
      "ADAPTER_ERROR",
      `Cloudflare preview runtime support for ${capability} is not enabled.`,
      501,
    ),
  );
}

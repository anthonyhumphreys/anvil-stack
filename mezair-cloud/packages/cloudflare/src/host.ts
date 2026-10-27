import { OidcTokenVerifier } from "@mezair-cloud/auth/dist/workerd.js";
import type { D1Database, Queue, R2Bucket } from "@cloudflare/workers-types";
import { CloudflareD1DatabaseAdapter } from "./database.js";
import { CloudflareR2FileAdapter } from "./files.js";

import {
  RuntimeError,
  type DatabaseAdapter,
  type DatabaseQueryClient,
  type DatabaseTableClient,
  type DatabaseWhereOperator,
  type RuntimeHost,
} from "@mezair-cloud/runtime";

export type CloudflareWorkerBindings = Record<string, unknown> & {
  MEZAIR_AUTH_ISSUER?: string;
  MEZAIR_AUTH_AUDIENCE?: string;
  MEZAIR_AUTH_JWKS_URI?: string;
  MEZAIR_DB?: D1Database;
  MEZAIR_FILES?: R2Bucket;
  MEZAIR_JOBS?: Queue<CloudflareJobMessage>;
  MEZAIR_ASSETS?: {
    fetch(request: Request): Promise<Response>;
  };
};

export type CloudflareJobMessage = {
  kind: "job";
  id: string;
  name: string;
  payload: unknown;
};

export function createCloudflareRuntimeHost(
  bindings: CloudflareWorkerBindings,
): RuntimeHost {
  const verifier =
    bindings.MEZAIR_AUTH_ISSUER && bindings.MEZAIR_AUTH_AUDIENCE
      ? new OidcTokenVerifier({
          issuer: bindings.MEZAIR_AUTH_ISSUER,
          audience: bindings.MEZAIR_AUTH_AUDIENCE.split(",").map((value) =>
            value.trim(),
          ),
          ...(bindings.MEZAIR_AUTH_JWKS_URI
            ? { jwksUri: bindings.MEZAIR_AUTH_JWKS_URI }
            : {}),
        })
      : undefined;
  return {
    db: bindings.MEZAIR_DB
      ? new CloudflareD1DatabaseAdapter(bindings.MEZAIR_DB)
      : new UnsupportedDatabaseAdapter(),
    files: bindings.MEZAIR_FILES
      ? new CloudflareR2FileAdapter(bindings.MEZAIR_FILES)
      : {
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
      async verifyToken(token) {
        if (!verifier)
          throw new RuntimeError(
            "AUTH_REQUIRED",
            "Configure an OIDC issuer and audience before using bearer authentication.",
            401,
          );
        return (await verifier.verifyToken(token)).identity;
      },
    },
    logs: {
      async write(entry) {
        const output = JSON.stringify({ source: "mezair-cloud", ...entry });

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
      async enqueue(name, payload, options) {
        if (!bindings.MEZAIR_JOBS) return unsupported("jobs");
        const id = options?.id ?? crypto.randomUUID();
        await bindings.MEZAIR_JOBS.send({ kind: "job", id, name, payload });
        return { id };
      },
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
      page: fail,
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

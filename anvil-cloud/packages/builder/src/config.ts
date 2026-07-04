import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { errorDiagnostic, type BuilderDiagnostic } from "./diagnostics.js";

export type CellConfig = {
  name: string;
  client: ClientConfig;
  entrypoints: {
    server: string;
    client: string;
  };
  runtime: string;
  region?: string;
};

export type ClientConfig = {
  kind: "vite-react" | "expo-router" | "headless";
};

export type LoadedCellConfig = {
  rootDir: string;
  path: string;
  config: CellConfig;
  serverEntry: string;
  clientEntry: string;
};

export async function loadCellConfig(
  rootDir: string,
): Promise<{ config?: LoadedCellConfig; diagnostics: BuilderDiagnostic[] }> {
  const configPath = path.join(rootDir, "anvil.json");
  let raw: string;

  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    return {
      diagnostics: [
        errorDiagnostic({
          code: "CONFIG_NOT_FOUND",
          message: "Could not find anvil.json.",
          file: path.relative(rootDir, configPath),
          hint: "Run anvil-cloud new <name> or create an anvil.json file.",
        }),
      ],
    };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    return {
      diagnostics: [
        errorDiagnostic({
          code: "CONFIG_INVALID_JSON",
          message:
            error instanceof Error
              ? `anvil.json is not valid JSON: ${error.message}`
              : "anvil.json is not valid JSON.",
          file: path.relative(rootDir, configPath),
        }),
      ],
    };
  }

  const validation = validateCellConfig(parsed);

  if (validation.diagnostics.length > 0 || !validation.config) {
    return {
      diagnostics: validation.diagnostics,
    };
  }

  const loaded: LoadedCellConfig = {
    rootDir,
    path: configPath,
    config: validation.config,
    serverEntry: path.resolve(rootDir, validation.config.entrypoints.server),
    clientEntry: path.resolve(rootDir, validation.config.entrypoints.client),
  };
  const diagnostics: BuilderDiagnostic[] = [];

  await requireFile(
    rootDir,
    loaded.serverEntry,
    "SERVER_ENTRY_NOT_FOUND",
    diagnostics,
  );
  await requireFile(
    rootDir,
    loaded.clientEntry,
    "CLIENT_ENTRY_NOT_FOUND",
    diagnostics,
  );

  if (diagnostics.length > 0) {
    return { diagnostics };
  }

  return {
    config: loaded,
    diagnostics,
  };
}

function validateCellConfig(config: unknown): {
  config?: CellConfig;
  diagnostics: BuilderDiagnostic[];
} {
  const diagnostics: BuilderDiagnostic[] = [];

  if (!isObject(config)) {
    return {
      diagnostics: [
        errorDiagnostic({
          code: "CONFIG_INVALID",
          message: "anvil.json must be a JSON object.",
          file: "anvil.json",
        }),
      ],
    };
  }

  const name = readString(config, "name", diagnostics);
  const entrypoints = isObject(config.entrypoints)
    ? config.entrypoints
    : undefined;

  if (!entrypoints) {
    diagnostics.push(
      errorDiagnostic({
        code: "CONFIG_INVALID",
        message:
          "anvil.json must define entrypoints.server and entrypoints.client.",
        file: "anvil.json",
      }),
    );
  }

  const server = entrypoints
    ? readString(entrypoints, "server", diagnostics, "entrypoints.server")
    : undefined;
  const client = entrypoints
    ? readString(entrypoints, "client", diagnostics, "entrypoints.client")
    : undefined;
  const runtime =
    typeof config.runtime === "string" && config.runtime.length > 0
      ? config.runtime
      : "nodejs20";
  const clientKind = readClientKind(config, diagnostics);
  const region =
    typeof config.region === "string" && config.region.length > 0
      ? config.region
      : undefined;

  if (diagnostics.length > 0 || !name || !server || !client || !clientKind) {
    return { diagnostics };
  }

  const validConfig: CellConfig = {
    name,
    client: {
      kind: clientKind,
    },
    entrypoints: {
      server,
      client,
    },
    runtime,
  };

  if (region !== undefined) {
    validConfig.region = region;
  }

  return {
    config: validConfig,
    diagnostics,
  };
}

function readClientKind(
  config: Record<string, unknown>,
  diagnostics: BuilderDiagnostic[],
): ClientConfig["kind"] | undefined {
  if (config.client === undefined) {
    return "vite-react";
  }

  if (!isObject(config.client)) {
    diagnostics.push(
      errorDiagnostic({
        code: "CONFIG_INVALID",
        message: "anvil.json client must be an object when provided.",
        file: "anvil.json",
      }),
    );
    return undefined;
  }

  const kind = config.client.kind;

  if (kind === "vite-react" || kind === "expo-router" || kind === "headless") {
    return kind;
  }

  diagnostics.push(
    errorDiagnostic({
      code: "CONFIG_INVALID",
      message:
        "anvil.json client.kind must be one of 'vite-react', 'expo-router', or 'headless'.",
      file: "anvil.json",
    }),
  );

  return undefined;
}

async function requireFile(
  rootDir: string,
  filePath: string,
  code: string,
  diagnostics: BuilderDiagnostic[],
): Promise<void> {
  try {
    await access(filePath);
  } catch {
    diagnostics.push(
      errorDiagnostic({
        code,
        message: `Required Cell entrypoint '${path.relative(rootDir, filePath)}' does not exist.`,
        file: path.relative(rootDir, filePath),
      }),
    );
  }
}

function readString(
  object: Record<string, unknown>,
  property: string,
  diagnostics: BuilderDiagnostic[],
  label = property,
): string | undefined {
  const value = object[property];

  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  diagnostics.push(
    errorDiagnostic({
      code: "CONFIG_INVALID",
      message: `anvil.json must define a non-empty string '${label}'.`,
      file: "anvil.json",
    }),
  );

  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

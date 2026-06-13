import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { bundleClient, bundleServer } from "./bundle.js";
import { loadCellConfig } from "./config.js";
import type { LoadedCellConfig } from "./config.js";
import {
  type BuilderDiagnostic,
  type BuilderPhase,
  type BuildOutput,
  type BuildResult,
  hasErrors,
} from "./diagnostics.js";
import {
  renderGeneratedClient,
  renderGeneratedTypes,
} from "./generated-client.js";
import { checkImportPolicy } from "./import-policy.js";
import {
  createCellManifest,
  isAppDefinition,
  type CellManifest,
} from "./manifest.js";
import { typecheckCell } from "./typecheck.js";

export type BuildCellOptions = {
  rootDir?: string;
  distDir?: string;
  generatedDir?: string;
  target?: string;
  write?: boolean;
};

export async function checkCell(
  options: BuildCellOptions = {},
): Promise<BuildResult> {
  return runBuildPipeline({
    ...options,
    write: false,
  });
}

export async function buildCell(
  options: BuildCellOptions = {},
): Promise<BuildResult> {
  return runBuildPipeline({
    ...options,
    write: options.write ?? true,
  });
}

async function runBuildPipeline(
  options: Required<Pick<BuildCellOptions, "write">> & BuildCellOptions,
): Promise<BuildResult> {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const loadedConfig = await loadCellConfig(rootDir);

  if (loadedConfig.diagnostics.length > 0 || !loadedConfig.config) {
    return failed("config", loadedConfig.diagnostics);
  }

  const importDiagnostics = await checkImportPolicy({
    rootDir,
    serverEntry: loadedConfig.config.serverEntry,
  });

  if (hasErrors(importDiagnostics)) {
    return failed("import-policy", importDiagnostics);
  }

  const typecheckDiagnostics = await typecheckCell(rootDir);

  if (hasErrors(typecheckDiagnostics)) {
    return failed("typecheck", typecheckDiagnostics);
  }

  if (!options.write) {
    return {
      ok: true,
      diagnostics: [
        ...loadedConfig.diagnostics,
        ...importDiagnostics,
        ...typecheckDiagnostics,
      ],
    };
  }

  const output = createOutputPaths(rootDir, options);

  await rm(output.distDir, { recursive: true, force: true });
  await rm(output.generatedDir, { recursive: true, force: true });
  await mkdir(path.dirname(output.serverBundle), { recursive: true });
  await mkdir(path.dirname(output.clientIndex), { recursive: true });
  await mkdir(output.generatedDir, { recursive: true });

  const serverDiagnostics = await bundleServer({
    rootDir,
    entry: loadedConfig.config.serverEntry,
    outfile: output.serverBundle,
  });

  if (hasErrors(serverDiagnostics)) {
    return failed("server-bundle", serverDiagnostics, output);
  }

  const manifestResult = await extractManifest(
    output.serverBundle,
    loadedConfig.config,
    options.target ?? "local",
  );

  if (manifestResult.diagnostics.length > 0 || !manifestResult.manifest) {
    return failed("manifest", manifestResult.diagnostics, output);
  }

  await writeBuildOutputs(output, manifestResult.manifest);

  const clientDiagnostics = await bundleClient({
    rootDir,
    entry: loadedConfig.config.clientEntry,
    outfile: path.join(output.distDir, "client", "assets", "cell.client.js"),
    indexFile: output.clientIndex,
  });

  if (hasErrors(clientDiagnostics)) {
    return failed("client-bundle", clientDiagnostics, output);
  }

  return {
    ok: true,
    diagnostics: [
      ...loadedConfig.diagnostics,
      ...importDiagnostics,
      ...typecheckDiagnostics,
    ],
    output,
    manifest: manifestResult.manifest,
  };
}

async function extractManifest(
  serverBundle: string,
  config: LoadedCellConfig,
  target: string,
): Promise<{ manifest?: CellManifest; diagnostics: BuilderDiagnostic[] }> {
  try {
    const imported = (await import(
      `${pathToFileURL(serverBundle).href}?analysis=${Date.now()}`
    )) as { default?: unknown };

    if (!isAppDefinition(imported.default)) {
      return {
        diagnostics: [
          {
            code: "SERVER_EXPORT_INVALID",
            severity: "error",
            message:
              "The server entrypoint must default-export an app() definition.",
            file: path.relative(config.rootDir, config.serverEntry),
          },
        ],
      };
    }

    return {
      manifest: createCellManifest(imported.default, config.config, target),
      diagnostics: [],
    };
  } catch (error) {
    return {
      diagnostics: [
        {
          code: "MANIFEST_EXTRACTION_FAILED",
          severity: "error",
          message:
            error instanceof Error
              ? error.message
              : "Manifest extraction failed while importing the server bundle.",
          file: path.relative(config.rootDir, config.serverEntry),
        },
      ],
    };
  }
}

async function writeBuildOutputs(
  output: BuildOutput,
  manifest: CellManifest,
): Promise<void> {
  await writeFile(
    output.manifest,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    output.generatedClient,
    renderGeneratedClient(manifest),
    "utf8",
  );
  await writeFile(
    output.generatedTypes,
    renderGeneratedTypes(manifest),
    "utf8",
  );
  await writeFile(
    output.buildMeta,
    `${JSON.stringify(createBuildMeta(), null, 2)}\n`,
    "utf8",
  );
}

function createOutputPaths(
  rootDir: string,
  options: BuildCellOptions,
): BuildOutput {
  const distDir = path.resolve(rootDir, options.distDir ?? ".anvil/dist");
  const generatedDir = path.resolve(
    rootDir,
    options.generatedDir ?? ".anvil/generated",
  );

  return {
    distDir,
    generatedDir,
    serverBundle: path.join(distDir, "server", "index.mjs"),
    clientIndex: path.join(distDir, "client", "index.html"),
    manifest: path.join(distDir, "manifest.json"),
    buildMeta: path.join(distDir, "build-meta.json"),
    generatedClient: path.join(generatedDir, "client.ts"),
    generatedTypes: path.join(generatedDir, "api.d.ts"),
  };
}

function createBuildMeta(): Record<string, unknown> {
  return {
    buildId: `build_${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    builderVersion: "0.0.0",
    nodeVersion: process.version,
  };
}

function failed(
  phase: BuilderPhase,
  diagnostics: BuilderDiagnostic[],
  output?: BuildOutput,
): BuildResult {
  const result: BuildResult = {
    ok: false,
    phase,
    diagnostics,
  };

  if (output) {
    result.output = output;
  }

  return result;
}

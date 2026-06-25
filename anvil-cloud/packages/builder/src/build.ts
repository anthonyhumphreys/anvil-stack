import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  renderGeneratedClientTypecheckStub,
  renderGeneratedTypes,
} from "./generated-client.js";
import { checkImportPolicy } from "./import-policy.js";
import {
  createCellManifest,
  isAppDefinition,
  validateCellAgents,
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

  const output = createOutputPaths(rootDir, options);
  const previousManifest = options.write
    ? await readPreviousManifest(output.manifest)
    : null;

  if (options.write) {
    await rm(output.distDir, { recursive: true, force: true });
    await rm(output.generatedDir, { recursive: true, force: true });
  }

  const typecheckDiagnostics = await typecheckCell(rootDir, {
    virtualFiles: {
      [output.generatedClient]: renderGeneratedClientTypecheckStub(),
    },
  });

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

  const manifestGuardDiagnostics = compareManifestSafety(
    previousManifest,
    manifestResult.manifest,
  );

  if (hasErrors(manifestGuardDiagnostics)) {
    return failed("manifest", manifestGuardDiagnostics, output);
  }

  await writeBuildOutputs(output, manifestResult.manifest);

  const generatedTypecheckDiagnostics = await typecheckCell(rootDir);

  if (hasErrors(generatedTypecheckDiagnostics)) {
    return failed("typecheck", generatedTypecheckDiagnostics, output);
  }

  const clientDiagnostics =
    loadedConfig.config.config.client.kind === "vite-react"
      ? await bundleClient({
          rootDir,
          entry: loadedConfig.config.clientEntry,
          outfile: path.join(
            output.distDir,
            "client",
            "assets",
            "cell.client.js",
          ),
          indexFile: output.clientIndex,
        })
      : [];

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
  const analysisBundle = createAnalysisBundlePath(serverBundle);

  try {
    await copyFile(serverBundle, analysisBundle);
    const imported = (await import(pathToFileURL(analysisBundle).href)) as {
      default?: unknown;
    };

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

    const agentIssues = await validateCellAgents({
      app: imported.default,
      rootDir: config.rootDir,
    });
    const diagnostics: BuilderDiagnostic[] = agentIssues.map((issue) => {
      const diagnostic: BuilderDiagnostic = {
        code: issue.code,
        severity: issue.severity,
        message: issue.message,
      };

      if (issue.path !== undefined) {
        diagnostic.file = issue.path;
      }

      return diagnostic;
    });

    if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      return { diagnostics };
    }

    return {
      manifest: createCellManifest(imported.default, config.config, target),
      diagnostics,
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
  } finally {
    await rm(analysisBundle, { force: true });
  }
}

function createAnalysisBundlePath(serverBundle: string): string {
  const extension = path.extname(serverBundle);
  const basename = path.basename(serverBundle, extension);
  return path.join(
    path.dirname(serverBundle),
    `${basename}.analysis-${Date.now()}-${process.pid}-${randomUUID()}${extension}`,
  );
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

async function readPreviousManifest(
  manifestPath: string,
): Promise<CellManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    return isCellManifestLike(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function compareManifestSafety(
  previous: CellManifest | null,
  next: CellManifest,
): BuilderDiagnostic[] {
  if (!previous) {
    return [];
  }

  return [
    ...comparePublicFileAccess(previous, next),
    ...compareSchemaSafety(previous, next),
  ];
}

function comparePublicFileAccess(
  previous: CellManifest,
  next: CellManifest,
): BuilderDiagnostic[] {
  const previousPublic = filesPublicRead(previous.capabilities.files);
  const nextPublic = filesPublicRead(next.capabilities.files);

  if (previousPublic || !nextPublic) {
    return [];
  }

  return [
    {
      code: "PUBLIC_FILE_ACCESS_CHANGED",
      severity: "error",
      message:
        "capabilities.files.publicRead changed from false to true compared with the previous build.",
      hint: "Review public file exposure before enabling public reads. Delete .anvil/dist/manifest.json only if this is an intentional local baseline reset.",
    },
  ];
}

function compareSchemaSafety(
  previous: CellManifest,
  next: CellManifest,
): BuilderDiagnostic[] {
  const diagnostics: BuilderDiagnostic[] = [];

  for (const [tableName, previousTable] of Object.entries(
    previous.schema.tables,
  )) {
    const nextTable = next.schema.tables[tableName];

    if (!nextTable) {
      diagnostics.push({
        code: "DESTRUCTIVE_SCHEMA_CHANGE",
        severity: "error",
        message: `Schema table '${tableName}' was removed compared with the previous build.`,
        hint: "Add an explicit migration plan before removing Cell-owned data tables.",
      });
      continue;
    }

    for (const [fieldName, previousField] of Object.entries(
      previousTable.fields,
    )) {
      const nextField = nextTable.fields[fieldName];

      if (!nextField) {
        diagnostics.push({
          code: "DESTRUCTIVE_SCHEMA_CHANGE",
          severity: "error",
          message: `Schema field '${tableName}.${fieldName}' was removed compared with the previous build.`,
          hint: "Add an explicit migration plan before removing Cell-owned data fields.",
        });
        continue;
      }

      if (fieldType(previousField) !== fieldType(nextField)) {
        diagnostics.push({
          code: "DESTRUCTIVE_SCHEMA_CHANGE",
          severity: "error",
          message: `Schema field '${tableName}.${fieldName}' changed type from '${fieldType(previousField)}' to '${fieldType(nextField)}'.`,
          hint: "Add an explicit migration plan before changing Cell-owned data field types.",
        });
      }
    }
  }

  return diagnostics;
}

function filesPublicRead(capability: unknown): boolean {
  return (
    typeof capability === "object" &&
    capability !== null &&
    "publicRead" in capability &&
    capability.publicRead === true
  );
}

function fieldType(field: unknown): string {
  if (
    typeof field === "object" &&
    field !== null &&
    "type" in field &&
    typeof field.type === "string"
  ) {
    return field.type;
  }

  return "unknown";
}

function isCellManifestLike(value: unknown): value is CellManifest {
  return (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    "cell" in value &&
    "schema" in value &&
    "capabilities" in value
  );
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

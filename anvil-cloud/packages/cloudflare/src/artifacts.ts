import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { BuildOutput, CellManifest } from "@anvil-cloud/builder";
import { build, type Plugin } from "esbuild";

import { createCloudflareWorkerName } from "./naming.js";
import {
  checkCloudflarePreviewSupport,
  type CloudflareAuthenticationMode,
  type CloudflarePreviewSupportDiagnostic,
} from "./support.js";

export const CLOUDFLARE_COMPATIBILITY_DATE = "2026-08-01";

export type CloudflareWorkerArtifacts = {
  directory: string;
  worker: string;
  config: string;
  workerName: string;
  workerSha256: string;
  assetsDirectory?: string;
};

export type CreateCloudflareWorkerArtifactsOptions = {
  manifest: CellManifest;
  buildOutput: BuildOutput;
  environment?: string;
  outputDirectory?: string;
  authentication?: CloudflareAuthenticationMode;
};

export class CloudflareWorkerCompatibilityError extends Error {
  constructor(readonly diagnostics: CloudflarePreviewSupportDiagnostic[]) {
    super(
      `Cell cannot be bundled for Cloudflare preview: ${diagnostics
        .map((diagnostic) => diagnostic.feature)
        .join(", ")}.`,
    );
    this.name = "CloudflareWorkerCompatibilityError";
  }
}

export async function createCloudflareWorkerArtifacts(
  options: CreateCloudflareWorkerArtifactsOptions,
): Promise<CloudflareWorkerArtifacts> {
  const environment = options.environment ?? "preview";
  const supportDiagnostics = checkCloudflarePreviewSupport(options.manifest, {
    authentication: options.authentication ?? "permanent",
  });

  if (supportDiagnostics.length > 0) {
    throw new CloudflareWorkerCompatibilityError(supportDiagnostics);
  }

  const directory = path.resolve(
    options.outputDirectory ??
      path.join(options.buildOutput.distDir, "cloudflare", environment),
  );
  const worker = path.join(directory, "worker.mjs");
  const config = path.join(directory, "wrangler.jsonc");
  const workerName = createCloudflareWorkerName(
    options.manifest.cell.name,
    environment,
  );

  await mkdir(directory, { recursive: true });
  await bundleWorkerEntrypoint(options.buildOutput.serverBundle, worker);

  const assetsDirectory = existsSync(options.buildOutput.clientIndex)
    ? path.dirname(options.buildOutput.clientIndex)
    : undefined;
  await writeFile(
    config,
    `${JSON.stringify(
      {
        name: workerName,
        main: "./worker.mjs",
        compatibility_date: CLOUDFLARE_COMPATIBILITY_DATE,
        workers_dev: true,
        ...(assetsDirectory
          ? {
              assets: {
                directory: relativeConfigPath(directory, assetsDirectory),
                binding: "ANVIL_ASSETS",
                run_worker_first: true,
              },
            }
          : {}),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const workerBody = await readFile(worker);

  return {
    directory,
    worker,
    config,
    workerName,
    workerSha256: createHash("sha256").update(workerBody).digest("hex"),
    ...(assetsDirectory ? { assetsDirectory } : {}),
  };
}

async function bundleWorkerEntrypoint(
  serverBundle: string,
  outfile: string,
): Promise<void> {
  const resolveDir = path.dirname(outfile);
  const serverImport = relativeModulePath(resolveDir, serverBundle);

  await build({
    stdin: {
      contents: renderWorkerEntrypoint(serverImport),
      sourcefile: "worker-entry.mjs",
      resolveDir,
      loader: "js",
    },
    outfile,
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    sourcemap: true,
    write: true,
    logLevel: "silent",
    plugins: [cloudflareRuntimeEntryPlugin()],
  });
}

function renderWorkerEntrypoint(serverImport: string): string {
  return [
    `import app from ${JSON.stringify(serverImport)};`,
    'import { createCloudflareRuntimeHost } from "@anvil-cloud/cloudflare/host";',
    'import { createCloudflareWorkerHandler } from "@anvil-cloud/cloudflare/http";',
    "",
    "export default createCloudflareWorkerHandler(app, {",
    "  createHost: createCloudflareRuntimeHost,",
    "});",
    "",
  ].join("\n");
}

function cloudflareRuntimeEntryPlugin(): Plugin {
  const sources = resolveWorkspacePackageSources();

  return {
    name: "anvil-cloudflare-runtime-entry",
    setup(buildApi) {
      buildApi.onResolve(
        { filter: /^@anvil-cloud\/cloudflare\/(host|http)$/ },
        (args) => {
          const source = sources.get(args.path);

          return source ? { path: source } : undefined;
        },
      );
      buildApi.onResolve({ filter: /^@anvil-cloud\/runtime$/ }, () => {
        const source = sources.get("@anvil-cloud/runtime");

        return source ? { path: source } : undefined;
      });
    },
  };
}

function resolveWorkspacePackageSources(): Map<string, string> {
  const currentFile = fileURLToPath(import.meta.url);
  const sourcePackagesRoot = path.resolve(
    path.dirname(currentFile),
    "..",
    "..",
  );
  const packedPackagesRoot = path.resolve(
    path.dirname(currentFile),
    "packages",
  );
  const packagesRoot = [sourcePackagesRoot, packedPackagesRoot].find((root) =>
    existsSync(path.join(root, "cloudflare", "src", "host.ts")),
  );
  const sources = new Map<string, string>();

  if (!packagesRoot) return sources;

  sources.set(
    "@anvil-cloud/cloudflare/host",
    path.join(packagesRoot, "cloudflare", "src", "host.ts"),
  );
  sources.set(
    "@anvil-cloud/cloudflare/http",
    path.join(packagesRoot, "cloudflare", "src", "http.ts"),
  );
  sources.set(
    "@anvil-cloud/runtime",
    path.join(packagesRoot, "runtime", "src", "workerd.ts"),
  );

  return sources;
}

function relativeConfigPath(from: string, to: string): string {
  return relativeModulePath(from, to);
}

function relativeModulePath(from: string, to: string): string {
  const relative = path.relative(from, to).split(path.sep).join("/");

  return relative.startsWith(".") ? relative : `./${relative}`;
}

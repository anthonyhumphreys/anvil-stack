import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { BuildOutput, CellManifest } from "@anvil-cloud/builder";
import { build, type Plugin } from "esbuild";

import type { CloudFormationTemplate } from "./cloudformation.js";
import { createZip } from "./zip.js";

export type AwsDeployArtifact = {
  key: string;
  body: Uint8Array;
  contentType: string;
  sha256: string;
  cacheControl?: string;
};

export type AwsPreviewDeployArtifacts = {
  lambda: AwsDeployArtifact;
  template: AwsDeployArtifact;
  manifest: AwsDeployArtifact;
  clientAssets: AwsDeployArtifact[];
};

export type AwsPreviewDeployArtifactSummary = {
  lambda: {
    key: string;
    bytes: number;
    sha256: string;
  };
  template: {
    key: string;
    bytes: number;
    sha256: string;
  };
  manifest: {
    key: string;
    bytes: number;
    sha256: string;
  };
  clientAssets: Array<{
    key: string;
    bytes: number;
    contentType: string;
    sha256: string;
    cacheControl?: string;
  }>;
};

export type CreateAwsPreviewDeployArtifactsOptions = {
  manifest: CellManifest;
  template: CloudFormationTemplate;
  buildOutput: BuildOutput;
};

export async function createAwsPreviewDeployArtifacts(
  options: CreateAwsPreviewDeployArtifactsOptions,
): Promise<AwsPreviewDeployArtifacts> {
  const serverBundle = await readFile(options.buildOutput.serverBundle);
  const manifestBody = jsonBytes(options.manifest);
  const templateBody = jsonBytes(options.template);
  const lambdaEntrypoint = await bundleLambdaEntrypoint();
  const lambda = createZip([
    {
      path: "index.mjs",
      body: lambdaEntrypoint,
    },
    {
      path: "server/index.mjs",
      body: serverBundle,
    },
    {
      path: "manifest.json",
      body: manifestBody,
    },
  ]);
  const lambdaHash = sha256(lambda);
  const templateHash = sha256(templateBody);
  const manifestHash = sha256(manifestBody);

  return {
    lambda: {
      key: `${options.manifest.cell.name}/server-${shortHash(lambdaHash)}.zip`,
      body: lambda,
      contentType: "application/zip",
      sha256: lambdaHash,
    },
    template: {
      key: `${options.manifest.cell.name}/template.json`,
      body: templateBody,
      contentType: "application/json",
      sha256: templateHash,
    },
    manifest: {
      key: `${options.manifest.cell.name}/manifest.json`,
      body: manifestBody,
      contentType: "application/json",
      sha256: manifestHash,
    },
    clientAssets: await readClientAssets(
      options.manifest.cell.name,
      path.dirname(options.buildOutput.clientIndex),
    ),
  };
}

export function summarizeAwsPreviewDeployArtifacts(
  artifacts: AwsPreviewDeployArtifacts,
): AwsPreviewDeployArtifactSummary {
  return {
    lambda: summarizeArtifact(artifacts.lambda),
    template: summarizeArtifact(artifacts.template),
    manifest: summarizeArtifact(artifacts.manifest),
    clientAssets: artifacts.clientAssets.map((artifact) => ({
      ...summarizeArtifact(artifact),
      contentType: artifact.contentType,
      ...(artifact.cacheControl ? { cacheControl: artifact.cacheControl } : {}),
    })),
  };
}

async function readClientAssets(
  cellName: string,
  clientDir: string,
): Promise<AwsDeployArtifact[]> {
  const assets: AwsDeployArtifact[] = [];

  await collectClientAssets(cellName, clientDir, clientDir, assets);

  return assets;
}

async function collectClientAssets(
  cellName: string,
  rootDir: string,
  currentDir: string,
  assets: AwsDeployArtifact[],
): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const filePath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      await collectClientAssets(cellName, rootDir, filePath, assets);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const relativePath = path
      .relative(rootDir, filePath)
      .split(path.sep)
      .join("/");

    const body = await readArtifactBody(filePath);

    assets.push({
      key: `${cellName}/client/${relativePath}`,
      body,
      contentType: contentTypeFor(filePath),
      sha256: sha256(body),
      cacheControl: "no-cache",
    });
  }
}

function summarizeArtifact(artifact: AwsDeployArtifact): {
  key: string;
  bytes: number;
  sha256: string;
} {
  return {
    key: artifact.key,
    bytes: artifact.body.byteLength,
    sha256: artifact.sha256,
  };
}

async function readArtifactBody(filePath: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(filePath));
}

function sha256(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

function jsonBytes(value: unknown): Uint8Array {
  return new Uint8Array(
    Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"),
  );
}

async function bundleLambdaEntrypoint(): Promise<Uint8Array> {
  const result = await build({
    stdin: {
      contents: renderLambdaEntrypoint(),
      sourcefile: "index.mjs",
      resolveDir: process.cwd(),
      loader: "js",
    },
    outfile: "index.mjs",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    banner: {
      js: [
        'import { createRequire } from "node:module";',
        "const require = createRequire(import.meta.url);",
      ].join("\n"),
    },
    write: false,
    logLevel: "silent",
    external: ["./server/index.mjs"],
    plugins: [awsRuntimeEntryPlugin()],
  });
  const [outputFile] = result.outputFiles ?? [];

  if (!outputFile) {
    throw new Error("AWS Lambda entrypoint bundle did not produce output.");
  }

  return outputFile.contents;
}

function renderLambdaEntrypoint(): string {
  return [
    'import app from "./server/index.mjs";',
    'import { createAwsRuntimeHostFromEnv } from "@anvil-cloud/aws/host";',
    'import { createAwsLambdaRuntimeHandler } from "@anvil-cloud/aws/lambda";',
    "",
    "const runtimeHost = createAwsRuntimeHostFromEnv();",
    "const runtimeHandler = createAwsLambdaRuntimeHandler(app, runtimeHost);",
    "",
    "export const handler = runtimeHandler;",
    "",
  ].join("\n");
}

function awsRuntimeEntryPlugin(): Plugin {
  const packageSources = resolveWorkspacePackageSources();

  return {
    name: "anvil-aws-runtime-entry",
    setup(buildApi) {
      buildApi.onResolve(
        { filter: /^@anvil-cloud\/aws\/(host|http|lambda)$/ },
        (args) => {
          const source = packageSources.get(args.path);

          if (!source) {
            return undefined;
          }

          return {
            path: source,
          };
        },
      );
      buildApi.onResolve({ filter: /^@anvil-cloud\/runtime$/ }, () => {
        const source = packageSources.get("@anvil-cloud/runtime");

        if (!source) {
          return undefined;
        }

        return {
          path: source,
        };
      });
      buildApi.onResolve({ filter: /^@anvil-cloud\/auth$/ }, () => {
        const source = packageSources.get("@anvil-cloud/auth");

        if (!source) {
          return undefined;
        }

        return {
          path: source,
        };
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
    existsSync(path.join(root, "aws", "src", "host.ts")),
  );
  const sources = new Map<string, string>();

  if (!packagesRoot) {
    return sources;
  }

  sources.set(
    "@anvil-cloud/aws/host",
    path.join(packagesRoot, "aws", "src", "host.ts"),
  );
  sources.set(
    "@anvil-cloud/aws/http",
    path.join(packagesRoot, "aws", "src", "http.ts"),
  );
  sources.set(
    "@anvil-cloud/aws/lambda",
    path.join(packagesRoot, "aws", "src", "lambda.ts"),
  );
  sources.set(
    "@anvil-cloud/runtime",
    path.join(packagesRoot, "runtime", "src", "index.ts"),
  );
  sources.set(
    "@anvil-cloud/auth",
    path.join(packagesRoot, "auth", "src", "index.ts"),
  );

  return sources;
}

function contentTypeFor(filePath: string): string {
  switch (path.extname(filePath)) {
    case ".css":
      return "text/css";
    case ".html":
      return "text/html";
    case ".js":
    case ".mjs":
      return "text/javascript";
    case ".json":
    case ".map":
      return "application/json";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

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
  };
  template: {
    key: string;
    bytes: number;
  };
  manifest: {
    key: string;
    bytes: number;
  };
  clientAssets: Array<{
    key: string;
    bytes: number;
    contentType: string;
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

  return {
    lambda: {
      key: `${options.manifest.cell.name}/server.zip`,
      body: lambda,
      contentType: "application/zip",
    },
    template: {
      key: `${options.manifest.cell.name}/template.json`,
      body: templateBody,
      contentType: "application/json",
    },
    manifest: {
      key: `${options.manifest.cell.name}/manifest.json`,
      body: manifestBody,
      contentType: "application/json",
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

    assets.push({
      key: `${cellName}/client/${relativePath}`,
      body: new Uint8Array(await readFile(filePath)),
      contentType: contentTypeFor(filePath),
    });
  }
}

function summarizeArtifact(artifact: AwsDeployArtifact): {
  key: string;
  bytes: number;
} {
  return {
    key: artifact.key,
    bytes: artifact.body.byteLength,
  };
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
    },
  };
}

function resolveWorkspacePackageSources(): Map<string, string> {
  const currentFile = fileURLToPath(import.meta.url);
  const packageRoot = path.resolve(path.dirname(currentFile), "..");
  const packagesRoot = path.resolve(packageRoot, "..");
  const sources = new Map<string, string>();

  sources.set(
    "@anvil-cloud/aws/host",
    path.join(packageRoot, "src", "host.ts"),
  );
  sources.set(
    "@anvil-cloud/aws/http",
    path.join(packageRoot, "src", "http.ts"),
  );
  sources.set(
    "@anvil-cloud/aws/lambda",
    path.join(packageRoot, "src", "lambda.ts"),
  );
  sources.set(
    "@anvil-cloud/runtime",
    path.join(packagesRoot, "runtime", "src", "index.ts"),
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

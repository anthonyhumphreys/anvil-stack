import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build, type Plugin } from "esbuild";
import { build as viteBuild, type InlineConfig } from "vite";

import { errorDiagnostic, type BuilderDiagnostic } from "./diagnostics.js";

export type BundleOptions = {
  rootDir: string;
  entry: string;
  outfile: string;
};

export async function bundleServer(
  options: BundleOptions,
): Promise<BuilderDiagnostic[]> {
  return runEsbuild({
    ...options,
    platform: "node",
    format: "esm",
    sourcemap: true,
    bundle: true,
    target: "node20",
  });
}

export async function bundleClient(
  options: BundleOptions & { indexFile: string },
): Promise<BuilderDiagnostic[]> {
  try {
    await mkdir(path.dirname(options.outfile), { recursive: true });
    await viteBuild(createClientBuildConfig(options));
    await writeClientIndex(options);

    return [];
  } catch (error) {
    return [
      errorDiagnostic({
        code: "BUNDLE_FAILED",
        message:
          error instanceof Error
            ? error.message
            : "The Cell client bundle failed to build.",
      }),
    ];
  }
}

function createClientBuildConfig(
  options: BundleOptions & { indexFile: string },
): InlineConfig {
  return {
    root: options.rootDir,
    configFile: false,
    logLevel: "silent",
    resolve: {
      alias: workspacePackageAliases(options.rootDir),
    },
    build: {
      outDir: path.dirname(options.indexFile),
      emptyOutDir: false,
      sourcemap: true,
      target: "es2022",
      rollupOptions: {
        input: options.entry,
        output: {
          entryFileNames: toPosixPath(
            path.relative(path.dirname(options.indexFile), options.outfile),
          ),
          chunkFileNames: "assets/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
        },
      },
    },
  };
}

async function writeClientIndex(
  options: BundleOptions & { indexFile: string },
): Promise<void> {
  const scriptPath = path.relative(
    path.dirname(options.indexFile),
    options.outfile,
  );

  await writeFile(
    options.indexFile,
    [
      "<!doctype html>",
      '<html lang="en">',
      "  <head>",
      '    <meta charset="utf-8" />',
      '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
      "    <title>Anvil Cell</title>",
      "  </head>",
      "  <body>",
      '    <div id="root"></div>',
      `    <script type="module" src="./${toPosixPath(scriptPath)}"></script>`,
      "  </body>",
      "</html>",
      "",
    ].join("\n"),
    "utf8",
  );
}

type EsbuildOptions = BundleOptions & {
  platform: "browser" | "node";
  format: "esm";
  sourcemap: boolean;
  bundle: boolean;
  target: string;
};

async function runEsbuild(
  options: EsbuildOptions,
): Promise<BuilderDiagnostic[]> {
  try {
    await mkdir(path.dirname(options.outfile), { recursive: true });
    await build({
      entryPoints: [options.entry],
      outfile: options.outfile,
      bundle: options.bundle,
      platform: options.platform,
      format: options.format,
      target: options.target,
      sourcemap: options.sourcemap,
      absWorkingDir: options.rootDir,
      plugins: [workspacePackagePlugin()],
      logLevel: "silent",
    });

    return [];
  } catch (error) {
    return [
      errorDiagnostic({
        code: "BUNDLE_FAILED",
        message:
          error instanceof Error
            ? error.message
            : "The Cell bundle failed to build.",
      }),
    ];
  }
}

function workspacePackagePlugin(): Plugin {
  const packageSources = resolveWorkspacePackageSources();

  return {
    name: "anvil-workspace-packages",
    setup(buildApi) {
      buildApi.onResolve(
        { filter: /^@anvil-cloud\/(runtime|client)$/ },
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
    },
  };
}

function resolveWorkspacePackageSources(): Map<string, string> {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  const workspacePackagesRoot = path.resolve(currentDir, "..", "..");
  const packedPackagesRoot = path.resolve(currentDir, "packages");
  const sources = new Map<string, string>();

  addFirstExistingSource(sources, "@anvil-cloud/runtime", [
    path.join(workspacePackagesRoot, "runtime", "src", "index.ts"),
    path.join(packedPackagesRoot, "runtime", "src", "index.ts"),
  ]);
  addFirstExistingSource(sources, "@anvil-cloud/client", [
    path.join(workspacePackagesRoot, "client", "src", "index.ts"),
    path.join(packedPackagesRoot, "client", "src", "index.ts"),
  ]);

  return sources;
}

function addFirstExistingSource(
  sources: Map<string, string>,
  specifier: string,
  candidates: string[],
): void {
  const source = candidates.find((candidate) => existsSync(candidate));

  if (source) {
    sources.set(specifier, source);
  }
}

function workspacePackageAliases(rootDir: string): Record<string, string> {
  return Object.fromEntries([
    ...resolveWorkspacePackageSources(),
    [
      "@anvil/generated/client",
      path.resolve(rootDir, ".anvil/generated/client.ts"),
    ],
  ]);
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

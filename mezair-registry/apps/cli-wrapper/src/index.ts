#!/usr/bin/env node
import { spawn as spawnChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

type Product = "cloud" | "registry";

type ProductConfig = {
  packageName: string;
  binary: string;
  binPath: string;
};

type SpawnProduct = (product: Product, args: string[]) => Promise<number>;

export type WrapperDependencies = {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
  spawnProduct: SpawnProduct;
};

const products: Record<Product, ProductConfig> = {
  cloud: {
    packageName: "@mezairstack/cloud-cli",
    binary: "mezair-cloud",
    binPath: "dist/index.js",
  },
  registry: {
    packageName: "@mezairstack/registry-cli",
    binary: "mezair-registry",
    binPath: "dist/index.js",
  },
};

const legacyRegistryCommands = new Set([
  "doctor",
  "explain",
  "scan",
  "warm",
  "smoke",
  "approve",
  "revoke",
  "llm-review",
  "queue",
  "overrides",
  "audit-events",
  "reports",
  "popular-index",
  "node-base",
  "policy",
]);

export async function run(
  argv: string[],
  dependencies: WrapperDependencies = defaultDependencies(),
): Promise<number> {
  const [command, ...args] = argv[0] === "--" ? argv.slice(1) : argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    dependencies.stdout.write(usage());
    return 0;
  }

  if (command === "version" || command === "--version" || command === "-v") {
    dependencies.stdout.write(`${await readWrapperVersion()}\n`);
    return 0;
  }

  if (command === "cloud" || command === "registry") {
    return dependencies.spawnProduct(command, args);
  }

  if (legacyRegistryCommands.has(command)) {
    dependencies.stderr.write(
      "Deprecated: use `mezair registry ...` or `mezair-registry ...` for Registry commands.\n",
    );
    return dependencies.spawnProduct("registry", [command, ...args]);
  }

  dependencies.stderr.write(`Unknown Mezair product or command: ${command}\n\n`);
  dependencies.stdout.write(usage());
  return 1;
}

async function readWrapperVersion(): Promise<string> {
  const packageJsonUrl = new URL("../package.json", import.meta.url);
  const packageJson = JSON.parse(await readFile(packageJsonUrl, "utf8")) as { version?: unknown };
  return typeof packageJson.version === "string" ? packageJson.version : "unknown";
}

function usage(): string {
  return `Mezair CLI

Usage:
  mezair cloud <command> [...args]
  mezair registry <command> [...args]
  mezair --version

Direct product binaries:
  mezair-cloud <command> [...args]
  mezair-registry <command> [...args]

Examples:
  mezair cloud check --json
  mezair cloud dev
  mezair registry scan package-lock.json --queue-analysis
  mezair registry explain react@latest

Install the product CLI you want to use:
  npm install --global @mezairstack/cli
  npm install --global @mezairstack/cloud-cli
  npm install --global @mezairstack/registry-cli
`;
}

function defaultDependencies(): WrapperDependencies {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    spawnProduct: spawnProductCli,
  };
}

async function spawnProductCli(product: Product, args: string[]): Promise<number> {
  const config = products[product];
  const resolvedBin = await resolvePackageBin(config);
  const executable = resolvedBin ? process.execPath : config.binary;
  const executableArgs = resolvedBin ? [resolvedBin, ...args] : args;

  return new Promise((resolve) => {
    const child = spawnChildProcess(executable, executableArgs, {
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        process.stderr.write(
          `Could not find ${config.binary}. Install ${config.packageName} or put ${config.binary} on PATH.\n`,
        );
        resolve(127);
        return;
      }

      process.stderr.write(`${error.message}\n`);
      resolve(1);
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        process.stderr.write(`${config.binary} exited from signal ${signal}\n`);
        resolve(1);
        return;
      }

      resolve(code ?? 1);
    });
  });
}

async function resolvePackageBin(config: ProductConfig): Promise<string | undefined> {
  try {
    const require = createRequire(import.meta.url);
    const packageJsonPath = require.resolve(`${config.packageName}/package.json`);
    const binPath = path.join(path.dirname(packageJsonPath), config.binPath);
    await access(binPath);
    return binPath;
  } catch {
    return undefined;
  }
}

if (isDirectCliEntry()) {
  process.exitCode = await run(process.argv.slice(2));
}

function isDirectCliEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;

  if (pathToFileURL(entry).href === import.meta.url) return true;

  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

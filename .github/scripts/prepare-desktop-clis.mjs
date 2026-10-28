import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Desktop installs these publishable packages with file: dependencies. Build
// them first so a fresh checkout does not need unpublished npm package names.
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const products = [
  {
    workspace: "mezair-cloud",
    packageDirectory: "packages/cli",
    name: "@mezairstack/cloud-cli",
    binary: "mezair-cloud",
    filter: "@mezairstack/cloud-cli...",
  },
  {
    workspace: "mezair-registry",
    packageDirectory: "apps/cli",
    name: "@mezairstack/registry-cli",
    binary: "mezair-registry",
    filter: "@mezairstack/registry-cli",
  },
];

function run(command, args, cwd, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: capture ? "pipe" : "inherit",
    encoding: "utf8",
    // Windows package-manager shims are .cmd files. All arguments are fixed
    // product definitions above; no user input is passed through the shell.
    shell: process.platform === "win32" && command === "pnpm",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (capture) process.stderr.write(`${result.stdout ?? ""}${result.stderr ?? ""}`);
    throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? result.signal}).`);
  }
}

for (const product of products) {
  const workspace = path.join(repositoryRoot, product.workspace);
  console.log(`Preparing ${product.name} from ${product.workspace}`);
  run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], workspace);
  run("pnpm", ["--filter", product.filter, "build"], workspace);
  const packageDirectory = path.join(workspace, product.packageDirectory);
  const manifest = JSON.parse(await readFile(path.join(packageDirectory, "package.json"), "utf8"));
  if (manifest.name !== product.name || typeof manifest.bin?.[product.binary] !== "string") {
    throw new Error(`Unexpected CLI package manifest in ${packageDirectory}.`);
  }
  const entrypoint = path.join(packageDirectory, manifest.bin[product.binary]);
  await access(entrypoint, constants.R_OK);
  run(process.execPath, ["--check", entrypoint], packageDirectory, true);
}

console.log("Local Mezair CLI packages are ready. Install Desktop dependencies next.");

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = resolve(workspaceRoot, "infra/docker/release/docker-compose.yml");
const envFile = resolve(workspaceRoot, "infra/docker/release/.env.example");
const packageJson = JSON.parse(await readFile(resolve(workspaceRoot, "package.json"), "utf8"));
const exampleEnv = parseEnv(await readFile(envFile, "utf8"));
const expectedReleaseTag = `registry-v${packageJson.version}`;

assert(exampleEnv.ANVIL_REGISTRY_VERSION === expectedReleaseTag, `.env.example must pin ${expectedReleaseTag}`);
assert(exampleEnv.PUBLIC_BASE_URL && !exampleEnv.PUBLIC_BASE_URL.includes("localhost"), ".env.example must use a remotely reachable PUBLIC_BASE_URL");
assert(exampleEnv.RUNTIME_MODE === "development", ".env.example must start alpha pilots in development mode");

for (const secret of ["ANVIL_ADMIN_TOKEN", "POSTGRES_PASSWORD", "MINIO_ROOT_PASSWORD"]) {
  assert(exampleEnv[secret]?.startsWith("replace-with-"), `.env.example must make ${secret} an explicit placeholder`);
}

const compose = spawnSync(
  "docker",
  ["compose", "--env-file", envFile, "-f", composeFile, "config", "--format", "json"],
  { cwd: workspaceRoot, encoding: "utf8" }
);

if (compose.status !== 0) {
  process.stderr.write(compose.stderr);
  process.exit(compose.status ?? 1);
}

const config = JSON.parse(compose.stdout);
const requiredServices = ["gateway", "worker", "admin", "migrate", "postgres", "redis", "minio", "minio-init"];
for (const service of requiredServices) assert(config.services?.[service], `release Compose is missing ${service}`);

for (const service of ["gateway", "worker", "admin", "migrate"]) {
  const definition = config.services[service];
  assert(!definition.build, `${service} must use a released image instead of a source build`);
  assert(definition.image?.includes(`:${expectedReleaseTag}`), `${service} image must use ${expectedReleaseTag}`);
}

for (const service of ["migrate", "postgres", "redis", "minio", "minio-init"]) {
  assert(!config.services[service].ports, `${service} must not publish a host port`);
}

assert(config.services.gateway.ports?.length === 1, "gateway must publish exactly one host port");
assert(config.services.admin.ports?.length === 1, "admin must publish exactly one host port");
assert(config.services.gateway.environment.PUBLIC_BASE_URL === exampleEnv.PUBLIC_BASE_URL, "gateway must receive PUBLIC_BASE_URL");
assert(config.services.gateway.environment.ANVIL_ADMIN_TOKEN === exampleEnv.ANVIL_ADMIN_TOKEN, "gateway must receive ANVIL_ADMIN_TOKEN");
assert(config.services.admin.environment.ANVIL_ADMIN_TOKEN === exampleEnv.ANVIL_ADMIN_TOKEN, "admin must receive ANVIL_ADMIN_TOKEN");

process.stdout.write(`Validated release Compose bundle for ${expectedReleaseTag}.\n`);

function parseEnv(source) {
  return Object.fromEntries(
    source
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        return separator === -1 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
      })
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

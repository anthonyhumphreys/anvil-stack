import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = resolve(workspaceRoot, "infra/docker/release/docker-compose.yml");
const codexComposeFile = resolve(workspaceRoot, "infra/docker/release/docker-compose.codex.yml");
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

const codexCompose = spawnSync(
  "docker",
  ["compose", "--env-file", envFile, "-f", composeFile, "-f", codexComposeFile, "config", "--format", "json"],
  { cwd: workspaceRoot, encoding: "utf8", env: { ...process.env, CODEX_AUTH_FILE: "/home/anvil/.codex/auth.json" } }
);

if (codexCompose.status !== 0) {
  process.stderr.write(codexCompose.stderr);
  process.exit(codexCompose.status ?? 1);
}

const codexConfig = JSON.parse(codexCompose.stdout);
for (const service of ["gateway", "worker", "admin"]) {
  assert(codexConfig.services[service].environment.LLM_REVIEW_ENABLED === "true", `${service} must enable Codex review`);
  assert(codexConfig.services[service].environment.LLM_REVIEW_PROVIDER === "codex-cli", `${service} must select the Codex CLI provider`);
}
const codexMount = codexConfig.services.worker.volumes?.find((volume) => volume.target === "/var/lib/anvil-codex/auth.json");
assert(codexMount?.type === "bind" && codexMount.read_only === true, "worker must mount only auth.json read-only");
for (const service of ["gateway", "admin"]) {
  assert(!codexConfig.services[service].volumes?.some((volume) => volume.target?.includes("anvil-codex")), `${service} must not receive Codex credentials`);
}
assert(codexConfig.services.worker.cap_drop?.includes("ALL"), "Codex worker override must drop Linux capabilities");
assert(codexConfig.services.worker.security_opt?.includes("no-new-privileges:true"), "Codex worker override must prevent privilege escalation");

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

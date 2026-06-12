# Anvil Node Base Specification

**Product name:** Anvil Node Base  
**Tagline:** A hardened Node devcontainer base image for safer dependency installs.

---

## 1. Purpose

Anvil Node Base is a hardened devcontainer base image for Node projects. It reduces risk from malicious npm dependency installs by enforcing safer npm defaults, providing install-script monitoring, and scanning for indicators of compromise during dependency installation.

It is not a replacement for Anvil Registry. It is a local safety harness.

Use cases:

- Devcontainers.
- CI containers.
- Codex/Cursor/agentic coding sandboxes.
- Unknown repo inspection.
- Pull request dependency review.

---

## 2. Security Goals

The image should:

1. Run as a non-root user.
2. Default npm to safer settings.
3. Prefer `npm ci` for lockfile installs.
4. Optionally force `ignore-scripts`.
5. Detect lifecycle scripts in dependencies.
6. Monitor suspicious network activity during install.
7. Detect suspicious filesystem access during install.
8. Produce an install security report.
9. Fail install on high-confidence IOCs in strict mode.

---

## 3. Image Name


Personal/internal image name:

```text
ghcr.io/anthonyhumphreys/anvil-node-base:22
```

---

## 4. Base Image

Use the Microsoft devcontainer Node image or official Node slim.

Recommended:

```dockerfile
FROM mcr.microsoft.com/devcontainers/javascript-node:1-22-bookworm
```

Reasoning:

- Better devcontainer ergonomics.
- Non-root `node` user available.
- Common development tools already present.
- Works naturally with VS Code devcontainers and agentic coding workflows.

---

## 5. Included Tools

The image should include:

- Node.js.
- npm.
- pnpm via Corepack.
- Yarn via Corepack.
- Git.
- curl.
- jq.
- ripgrep.
- strace.
- lsof.
- tcpdump, optional.
- tshark, optional.
- Python 3.
- CA certificates.

Keep `tcpdump` and `tshark` optional because they may require extra container capabilities.

---

## 6. npm Defaults

Global `/etc/npmrc`:

```ini
audit=true
fund=false
package-lock=true
save-exact=true
ignore-scripts=true
foreground-scripts=true
```

Important nuance:

```text
ignore-scripts=true is safest, but some packages need install scripts.
```

So the image should provide two install modes:

```bash
anvil-npm-ci-safe
anvil-npm-ci-observed
```

### 6.1 Safe mode

```bash
npm ci --ignore-scripts
```

### 6.2 Observed mode

```bash
npm ci --foreground-scripts
```

Observed mode allows scripts but wraps the install with monitoring.

---

## 7. CLI Tools Inside Image

## 7.1 `anvil-npm-ci-safe`

Purpose:

```text
Install dependencies without running lifecycle scripts.
Generate report of packages that wanted scripts.
```

Command:

```bash
anvil-npm-ci-safe
```

Behaviour:

1. Run `npm ci --ignore-scripts`.
2. Scan `node_modules` package manifests for lifecycle scripts.
3. Report packages that contain `install`, `preinstall`, `postinstall`, or `prepare` scripts.
4. Exit 0 unless strict mode requires failure.

---

## 7.2 `anvil-npm-ci-observed`

Purpose:

```text
Run npm ci while observing install scripts for indicators of compromise.
```

Command:

```bash
anvil-npm-ci-observed
```

Behaviour:

1. Snapshot environment.
2. Start network/process/filesystem monitor.
3. Run `npm ci --foreground-scripts` with scripts enabled.
4. Capture process tree.
5. Capture attempted outbound connections.
6. Scan install logs.
7. Scan package lifecycle scripts.
8. Produce JSON and Markdown report.
9. Fail if strict mode and high-confidence IOCs are detected.

---

## 7.3 `anvil-dep-report`

Purpose:

```text
Generate a dependency security report from existing node_modules without installing.
```

Command:

```bash
anvil-dep-report
```

Behaviour:

1. Scan `node_modules` package manifests.
2. Identify lifecycle scripts.
3. Identify suspicious script contents.
4. Identify suspicious package names or low-quality metadata if registry data is available.
5. Write JSON report to `.anvil/reports`.

---

## 8. IOC Markers

## 8.1 Network IOCs

Flag install scripts that attempt:

- HTTP/HTTPS requests to unknown domains.
- Requests to raw GitHub content.
- Requests to paste sites.
- Requests to IP addresses directly.
- DNS lookups for suspicious/generated domains.
- Connections to non-443/80 ports.
- Connections during `preinstall`, `install`, or `postinstall`.

Risk examples:

```bash
curl http://x.x.x.x/payload.sh | bash
wget https://example.com/install.sh
node -e "fetch('https://...')"
python -c "requests.post(...)"
```

---

## 8.2 Process IOCs

Flag:

- `child_process` execution.
- Shell piping into `bash` or `sh`.
- `chmod +x` followed by execution.
- Base64 decode followed by execution.
- Python/Perl/Ruby one-liners.
- PowerShell references.
- Background processes.
- `nohup` or `disown`.

---

## 8.3 Filesystem IOCs

Flag attempted access to:

- `~/.npmrc`
- `~/.ssh`
- `~/.aws`
- `~/.config/gcloud`
- `~/.azure`
- `.env`
- `.env.local`
- `.git/config`
- `.git-credentials`
- `id_rsa`
- `id_ed25519`
- `known_hosts`

---

## 8.4 Environment IOCs

Flag references to:

- `NPM_TOKEN`
- `NODE_AUTH_TOKEN`
- `GITHUB_TOKEN`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AZURE_CLIENT_SECRET`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `DATABASE_URL`

---

## 8.5 JavaScript Source IOCs

Scan install-path JS for:

- `process.env`
- `child_process`
- `execSync`
- `spawnSync`
- `http.request`
- `https.request`
- `fetch`
- `net.connect`
- `dns.lookup`
- `fs.readFileSync`
- `os.homedir`
- `Buffer.from(..., "base64")`
- `eval`
- `new Function`

---

## 9. Devcontainer Dockerfile

```dockerfile
FROM mcr.microsoft.com/devcontainers/javascript-node:1-22-bookworm

USER root

RUN apt-get update && apt-get install -y --no-install-recommends \
    jq \
    ripgrep \
    lsof \
    strace \
    ca-certificates \
    python3 \
    python3-pip \
  && rm -rf /var/lib/apt/lists/*

COPY npmrc /etc/npmrc
COPY scripts/anvil-npm-ci-safe /usr/local/bin/anvil-npm-ci-safe
COPY scripts/anvil-npm-ci-observed /usr/local/bin/anvil-npm-ci-observed
COPY scripts/anvil-dep-report /usr/local/bin/anvil-dep-report
COPY scripts/anvil-scan-lifecycle-scripts /usr/local/bin/anvil-scan-lifecycle-scripts
COPY scripts/anvil-scan-install-logs /usr/local/bin/anvil-scan-install-logs
COPY scripts/anvil-network-monitor /usr/local/bin/anvil-network-monitor

RUN chmod +x /usr/local/bin/anvil-*

USER node

ENV ANVIL_SECURITY_MODE=safe
ENV ANVIL_REPORT_DIR=/workspaces/.anvil/reports
ENV NPM_CONFIG_IGNORE_SCRIPTS=true
ENV NPM_CONFIG_FUND=false
ENV NPM_CONFIG_AUDIT=true
ENV NPM_CONFIG_SAVE_EXACT=true

CMD ["sleep", "infinity"]
```

---

## 10. `/etc/npmrc`

```ini
fund=false
audit=true
package-lock=true
save-exact=true
ignore-scripts=true
foreground-scripts=true
```

---

## 11. Script: `anvil-npm-ci-safe`

```bash
#!/usr/bin/env bash
set -euo pipefail

REPORT_DIR="${ANVIL_REPORT_DIR:-.anvil/reports}"
mkdir -p "$REPORT_DIR"

echo "[anvil] Running safe npm install: npm ci --ignore-scripts"

npm ci --ignore-scripts

echo "[anvil] Scanning dependency lifecycle scripts"
anvil-scan-lifecycle-scripts > "$REPORT_DIR/lifecycle-scripts.json"

echo "[anvil] Report written to $REPORT_DIR/lifecycle-scripts.json"

if [[ "${ANVIL_STRICT:-false}" == "true" ]]; then
  if jq -e '.packages | length > 0' "$REPORT_DIR/lifecycle-scripts.json" >/dev/null; then
    echo "[anvil] Strict mode: dependencies contain lifecycle scripts"
    exit 20
  fi
fi
```

---

## 12. Script: `anvil-npm-ci-observed`

```bash
#!/usr/bin/env bash
set -euo pipefail

REPORT_DIR="${ANVIL_REPORT_DIR:-.anvil/reports}"
mkdir -p "$REPORT_DIR"

export NPM_CONFIG_IGNORE_SCRIPTS=false
export NPM_CONFIG_FOREGROUND_SCRIPTS=true

echo "[anvil] Running observed npm install with scripts enabled"
echo "[anvil] Reports will be written to $REPORT_DIR"

set +e
strace -f \
  -e trace=network,process,file \
  -o "$REPORT_DIR/strace.log" \
  npm ci --foreground-scripts 2>&1 | tee "$REPORT_DIR/npm-install.log"

NPM_EXIT="${PIPESTATUS[0]}"
set -e

anvil-scan-lifecycle-scripts > "$REPORT_DIR/lifecycle-scripts.json"
anvil-scan-install-logs "$REPORT_DIR/npm-install.log" "$REPORT_DIR/strace.log" \
  > "$REPORT_DIR/ioc-report.json"

echo "[anvil] npm exited with $NPM_EXIT"
echo "[anvil] IOC report written to $REPORT_DIR/ioc-report.json"

if [[ "${ANVIL_STRICT:-false}" == "true" ]]; then
  if jq -e '.highConfidenceFindings | length > 0' "$REPORT_DIR/ioc-report.json" >/dev/null; then
    echo "[anvil] Strict mode: high-confidence IOCs detected"
    exit 21
  fi
fi

exit "$NPM_EXIT"
```

---

## 13. Script: `anvil-scan-lifecycle-scripts`

```bash
#!/usr/bin/env bash
set -euo pipefail

node <<'NODE'
const fs = require("fs");
const path = require("path");

const root = path.resolve("node_modules");
const lifecycleNames = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepublish",
  "prepublishOnly"
]);

const results = [];

function walk(dir) {
  if (!fs.existsSync(dir)) return;

  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith(".")) continue;

    const full = path.join(dir, entry);
    let stat;

    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }

    if (!stat.isDirectory()) continue;

    if (entry.startsWith("@")) {
      walk(full);
      continue;
    }

    const manifestPath = path.join(full, "package.json");

    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        const scripts = manifest.scripts || {};
        const lifecycleScripts = Object.fromEntries(
          Object.entries(scripts).filter(([name]) => lifecycleNames.has(name))
        );

        if (Object.keys(lifecycleScripts).length > 0) {
          results.push({
            name: manifest.name,
            version: manifest.version,
            path: path.relative(process.cwd(), full),
            scripts: lifecycleScripts
          });
        }
      } catch {
        // ignore malformed package manifests
      }
    }

    const nested = path.join(full, "node_modules");
    if (fs.existsSync(nested)) {
      walk(nested);
    }
  }
}

walk(root);

console.log(JSON.stringify({ packages: results }, null, 2));
NODE
```

---

## 14. Script: `anvil-scan-install-logs`

```bash
#!/usr/bin/env bash
set -euo pipefail

NPM_LOG="${1:-.anvil/reports/npm-install.log}"
STRACE_LOG="${2:-.anvil/reports/strace.log}"

node <<'NODE' "$NPM_LOG" "$STRACE_LOG"
const fs = require("fs");

const npmLogPath = process.argv[2];
const straceLogPath = process.argv[3];

const npmLog = fs.existsSync(npmLogPath) ? fs.readFileSync(npmLogPath, "utf8") : "";
const straceLog = fs.existsSync(straceLogPath) ? fs.readFileSync(straceLogPath, "utf8") : "";

const highPatterns = [
  { code: "CURL_PIPE_BASH", regex: /(curl|wget)[^|;&]+[|]\s*(bash|sh)/i },
  { code: "SECRET_ENV_ACCESS", regex: /(NPM_TOKEN|NODE_AUTH_TOKEN|GITHUB_TOKEN|AWS_SECRET_ACCESS_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY)/ },
  { code: "SSH_KEY_ACCESS", regex: /(\.ssh|id_rsa|id_ed25519)/ },
  { code: "NPMRC_ACCESS", regex: /\.npmrc/ },
  { code: "BASE64_EXEC", regex: /(base64\s+-d|Buffer\.from\(.+base64)/i }
];

const mediumPatterns = [
  { code: "CHILD_PROCESS", regex: /(child_process|execSync|spawnSync|exec\()/i },
  { code: "NETWORK_TOOL", regex: /\b(curl|wget|nc|netcat)\b/i },
  { code: "DIRECT_IP_CONNECTION", regex: /connect\(.+inet_addr\("?\d{1,3}(\.\d{1,3}){3}/i },
  { code: "ENV_ENUMERATION", regex: /(process\.env|env\s*>|printenv)/i },
  { code: "HOME_DIRECTORY_ACCESS", regex: /(\/home\/node|\/root|os\.homedir)/i }
];

function find(patterns, text, source) {
  return patterns
    .filter((p) => p.regex.test(text))
    .map((p) => ({
      code: p.code,
      source,
      matched: true
    }));
}

const highConfidenceFindings = [
  ...find(highPatterns, npmLog, "npm-log"),
  ...find(highPatterns, straceLog, "strace")
];

const mediumConfidenceFindings = [
  ...find(mediumPatterns, npmLog, "npm-log"),
  ...find(mediumPatterns, straceLog, "strace")
];

console.log(JSON.stringify({
  highConfidenceFindings,
  mediumConfidenceFindings,
  summary: {
    high: highConfidenceFindings.length,
    medium: mediumConfidenceFindings.length
  }
}, null, 2));
NODE
```

---

## 15. Script: `anvil-dep-report`

```bash
#!/usr/bin/env bash
set -euo pipefail

REPORT_DIR="${ANVIL_REPORT_DIR:-.anvil/reports}"
mkdir -p "$REPORT_DIR"

anvil-scan-lifecycle-scripts > "$REPORT_DIR/lifecycle-scripts.json"

cat > "$REPORT_DIR/dependency-report.md" <<'REPORT'
# Anvil Dependency Report

Generated by Anvil Node Base.

## Lifecycle Scripts

See `lifecycle-scripts.json` for packages that declare lifecycle scripts.

## Notes

This report does not prove a dependency is safe or unsafe. It highlights dependency install behaviours worth reviewing.
REPORT

echo "[anvil] Dependency report written to $REPORT_DIR"
```

---

## 16. Script: `anvil-network-monitor`

Runs an arbitrary command under network syscall tracing and writes:

- `network-strace.log`
- `network-report.json`
- `network-report.md`

It is intentionally strace-based so it works in ordinary devcontainers and CI jobs where packet capture tools often need extra container capabilities.

```bash
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  echo "Usage: anvil-network-monitor [--] <command> [args...]"
  exit 0
fi

if [[ "${1:-}" == "--" ]]; then
  shift
fi

if [[ "$#" -eq 0 ]]; then
  echo "[anvil] Usage: anvil-network-monitor [--] <command> [args...]" >&2
  exit 64
fi

REPORT_DIR="${ANVIL_REPORT_DIR:-.anvil/reports}"
mkdir -p "$REPORT_DIR"

strace -f -e trace=network -o "$REPORT_DIR/network-strace.log" "$@"
COMMAND_EXIT=$?

anvil-scan-install-logs /dev/null "$REPORT_DIR/network-strace.log" > "$REPORT_DIR/network-report.json"
# The implementation also writes a Markdown summary, submits the report when configured,
# and applies the shared strict-mode risk gate before returning the command exit code.
exit "$COMMAND_EXIT"
```

Future versions may optionally add `tcpdump`, eBPF, or sidecar-based monitoring when a container has the required capabilities. Those should remain optional because safer defaults should not require privileged containers just to discover that an install script opened a socket.

---

## 17. Devcontainer Usage

Example `.devcontainer/devcontainer.json`:

```json
{
  "name": "Node with Anvil Base",
  "image": "ghcr.io/anthonyhumphreys/anvil-node-base:22",
  "remoteUser": "node",
  "containerEnv": {
    "ANVIL_SECURITY_MODE": "safe",
    "ANVIL_STRICT": "false"
  },
  "postCreateCommand": "anvil-npm-ci-safe",
  "customizations": {
    "vscode": {
      "extensions": [
        "dbaeumer.vscode-eslint",
        "esbenp.prettier-vscode"
      ]
    }
  }
}
```

For suspicious repos or agentic coding:

```json
{
  "postCreateCommand": "ANVIL_STRICT=true anvil-npm-ci-safe"
}
```

For packages that require scripts:

```bash
anvil-npm-ci-observed
```

---

## 18. Relationship Between Anvil Registry and Anvil Node Base

They complement each other.

### Anvil Registry

Prevents risky packages from being selected, downloaded, or installed.

### Anvil Node Base

Reduces blast radius if install scripts run inside a devcontainer. Detects suspicious behaviour during dependency install and produces local reports for unknown repos.

### Best combined setup

```text
Devcontainer uses Anvil Node Base.
npm registry points to Anvil Registry.
npm defaults to ignore scripts.
Observed mode is used only when scripts are needed.
```

Example `.npmrc` inside devcontainer:

```ini
registry=https://npm.anvil.example.com
ignore-scripts=true
fund=false
audit=true
save-exact=true
```

---

## 19. Acceptance Criteria

## 19.1 Base image

- Builds from a Node 22 devcontainer-compatible base image.
- Runs as non-root user by default.
- Installs required scanning tools.
- Installs Anvil helper scripts into `/usr/local/bin`.
- Provides safe npm defaults through `/etc/npmrc` and environment variables.

## 19.2 Safe install mode

- Runs `npm ci --ignore-scripts`.
- Scans `node_modules` for lifecycle scripts.
- Writes JSON report.
- Supports strict mode failure when lifecycle scripts are present.

## 19.3 Observed install mode

- Runs `npm ci` with scripts enabled.
- Captures install logs.
- Captures syscall traces through `strace`.
- Scans for high-confidence IOC markers.
- Writes JSON IOC report.
- Supports strict mode failure when high-confidence IOCs are detected.

## 19.4 Dependency report

- Scans existing `node_modules`.
- Writes report artefacts to `.anvil/reports` or configured report directory.
- Does not require network access.

---

## 20. Build Roadmap

## Phase 1: Base image MVP

- Dockerfile.
- `/etc/npmrc`.
- `anvil-npm-ci-safe`.
- `anvil-scan-lifecycle-scripts`.
- `anvil-dep-report`.
- README.

## Phase 2: Observed install

- `anvil-npm-ci-observed`.
- `strace` monitoring.
- install log scanner.
- IOC JSON report.
- strict mode.

## Phase 3: Better detection

- Better parser for `strace` output.
- Domain allowlist/blocklist.
- Secret file access detection.
- Process tree reporting.
- Markdown summary report.

## Phase 4: Registry integration

- Support `ANVIL_REGISTRY_URL`.
- Generate `.npmrc` pointing to Anvil Registry.
- Remove scoped registry overrides by default so scoped package installs still pass through Anvil policy; allow an explicit opt-out for projects that intentionally keep direct scoped registry routing.
- Send validated JSON reports to Anvil Registry via `POST /-/anvil/node-base/reports`, passing `ANVIL_ADMIN_TOKEN` when the gateway is token-gated.

## Phase 5: Publish image

- Build and publish to GHCR.
- Add GitHub Actions workflow.
- Publish versioned tags:
  - `22`
  - `22-bookworm`
  - `latest`

The repository workflow `.github/workflows/node-base-image.yml` builds and validates the Node Base image for pull requests and publishes to `ghcr.io/<owner>/anvil-node-base` from `main` or `node-base-v*` tags.

# anvil-worker — generic cloud environment image (Vercel VCR / generic OCI /
# AWS microVM rootfs base). Runs the headless Anvil daemon as an ephemeral
# Mesh worker; see README.md for the bootstrap contract.
#
# Build:  ./prepare.sh && docker build -f Dockerfile -t anvil-worker .
FROM node:22-bookworm-slim

WORKDIR /opt/anvil

# better-sqlite3/node-pty ship prebuilds; the toolchain is belt-and-braces for
# platforms without one, plus git for code-task checkouts.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

ARG CODEX_CLI_VERSION=0.154.0
COPY install-codex-cli.sh ./install-codex-cli.sh
RUN CODEX_CLI_VERSION="$CODEX_CLI_VERSION" sh ./install-codex-cli.sh

# Cursor publishes pinned, architecture-specific tarballs. Devin publishes
# versioned Linux installers which validate downloaded bundles against the
# vendor manifest.
ARG TARGETARCH
ARG CURSOR_CLI_VERSION=2026.09.10-fd3934a
ARG DEVIN_CLI_VERSION=3000.11.3
COPY install-cursor-cli.sh ./
RUN TARGETARCH="$TARGETARCH" CURSOR_CLI_VERSION="$CURSOR_CLI_VERSION" sh ./install-cursor-cli.sh

COPY install-devin-cli.sh ./
RUN DEVIN_CLI_VERSION="$DEVIN_CLI_VERSION" bash ./install-devin-cli.sh

ENV PATH="/root/.local/bin:${PATH}"

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY anvil-daemon.mjs boot.mjs snapshot-lifecycle.mjs ./
COPY anvil-worker-boot ./bin/anvil-worker-boot
RUN chmod +x /opt/anvil/bin/anvil-worker-boot

ENV ANVIL_DATA_DIR=/var/lib/anvil
RUN mkdir -p /var/lib/anvil /run/anvil

# Provisioners may override argv with the bootstrap JSON; the ENTRYPOINT
# script accepts it as argv[2] in addition to the env/file channels.
ENTRYPOINT ["/opt/anvil/bin/anvil-worker-boot"]

# anvil-worker — generic cloud environment image (Vercel VCR / generic OCI /
# AWS microVM rootfs base). Runs the headless Anvil daemon as an ephemeral
# Mesh worker; see README.md for the bootstrap contract.
#
# Build:  ./prepare.sh && docker build -f Dockerfile -t anvil-worker .
FROM node:22-bookworm-slim

# better-sqlite3/node-pty ship prebuilds; the toolchain is belt-and-braces for
# platforms without one, plus git for code-task checkouts.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/anvil
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY anvil-daemon.mjs boot.mjs ./
COPY anvil-worker-boot ./bin/anvil-worker-boot
RUN chmod +x /opt/anvil/bin/anvil-worker-boot

ENV ANVIL_DATA_DIR=/var/lib/anvil
RUN mkdir -p /var/lib/anvil /run/anvil

# Provisioners may override argv with the bootstrap JSON; the ENTRYPOINT
# script accepts it as argv[2] in addition to the env/file channels.
ENTRYPOINT ["/opt/anvil/bin/anvil-worker-boot"]

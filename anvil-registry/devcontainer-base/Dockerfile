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
COPY scripts/anvil-risk-gate /usr/local/bin/anvil-risk-gate
COPY scripts/anvil-use-registry /usr/local/bin/anvil-use-registry
COPY scripts/anvil-submit-report /usr/local/bin/anvil-submit-report
COPY scripts/anvil-submit-report-if-configured /usr/local/bin/anvil-submit-report-if-configured

RUN chmod +x /usr/local/bin/anvil-*
RUN mkdir -p /workspaces/.anvil/reports && chown -R node:node /workspaces

USER node

ENV ANVIL_SECURITY_MODE=safe
ENV ANVIL_REPORT_DIR=/workspaces/.anvil/reports
ENV NPM_CONFIG_IGNORE_SCRIPTS=true
ENV NPM_CONFIG_FOREGROUND_SCRIPTS=true
ENV NPM_CONFIG_FUND=false
ENV NPM_CONFIG_AUDIT=true
ENV NPM_CONFIG_SAVE_EXACT=true

CMD ["sleep", "infinity"]

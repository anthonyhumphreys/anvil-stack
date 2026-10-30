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
COPY scripts/mezair-npm-ci-safe /usr/local/bin/mezair-npm-ci-safe
COPY scripts/mezair-npm-ci-observed /usr/local/bin/mezair-npm-ci-observed
COPY scripts/mezair-dep-report /usr/local/bin/mezair-dep-report
COPY scripts/mezair-scan-lifecycle-scripts /usr/local/bin/mezair-scan-lifecycle-scripts
COPY scripts/mezair-scan-install-logs /usr/local/bin/mezair-scan-install-logs
COPY scripts/mezair-network-monitor /usr/local/bin/mezair-network-monitor
COPY scripts/mezair-risk-gate /usr/local/bin/mezair-risk-gate
COPY scripts/mezair-use-registry /usr/local/bin/mezair-use-registry
COPY scripts/mezair-submit-report /usr/local/bin/mezair-submit-report
COPY scripts/mezair-submit-report-if-configured /usr/local/bin/mezair-submit-report-if-configured

RUN chmod +x /usr/local/bin/mezair-*
RUN mkdir -p /workspaces/.mezair/reports && chown -R node:node /workspaces

USER node

ENV MEZAIR_SECURITY_MODE=safe
ENV MEZAIR_REPORT_DIR=/workspaces/.mezair/reports
ENV NPM_CONFIG_IGNORE_SCRIPTS=true
ENV NPM_CONFIG_FOREGROUND_SCRIPTS=true
ENV NPM_CONFIG_FUND=false
ENV NPM_CONFIG_AUDIT=true
ENV NPM_CONFIG_SAVE_EXACT=true

CMD ["sleep", "infinity"]

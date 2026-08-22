---
title: Network policy
navTitle: Network policy
description: Configure allowed hosts, blocked hosts, ports, and severity levels for observed mode network monitoring.
product: Anvil Node Base
section: Guides
journey: build
order: 10
---

# Network policy

Anvil Node Base observed mode monitors network activity during dependency installation. The network policy lets you tune what is allowed, what is blocked, and how severe each finding should be.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANVIL_NETWORK_ALLOWED_PORTS` | `80,443` | Ports considered normal for outbound connections. |
| `ANVIL_NETWORK_ALLOWED_HOSTS` | `registry.npmjs.org,npm.pkg.github.com` | Hosts considered safe. |
| `ANVIL_NETWORK_BLOCKED_HOSTS` | `raw.githubusercontent.com,pastebin.com` | Hosts considered unsafe. |
| `ANVIL_NETWORK_DIRECT_IP_SEVERITY` | `medium` | Severity when a connection uses a raw IP instead of a hostname. |
| `ANVIL_NETWORK_NON_STANDARD_PORT_SEVERITY` | `medium` | Severity when a connection uses a port outside the allowed list. |
| `ANVIL_NETWORK_GENERATED_DOMAIN_SEVERITY` | `medium` | Severity when a domain looks algorithmically generated. |

## How monitoring works

Observed mode uses `strace` to capture network-related syscalls during `npm ci`. It records:

- `connect` calls with target host and port.
- DNS resolution attempts.
- Socket creation.

After the install completes, the network monitor:

1. Parses the strace log.
2. Resolves IP addresses to hostnames where possible.
3. Applies the network policy to each connection.
4. Writes `network-report.json` and `network-report.md`.

## Allowed hosts

Connections to allowed hosts are recorded but not flagged unless they use a non-standard port or other suspicious behaviour.

Add internal registries or known API hosts:

```bash
ANVIL_NETWORK_ALLOWED_HOSTS="registry.npmjs.org,npm.pkg.github.com,internal.registry.example.com"
```

## Blocked hosts

Connections to blocked hosts are always flagged. Use this for hosts that should never be contacted during install:

```bash
ANVIL_NETWORK_BLOCKED_HOSTS="pastebin.com,pastebin.pl,raw.githubusercontent.com"
```

## Severity levels

| Level | Meaning |
| --- | --- |
| `high` | Fails in strict mode. Should be reviewed immediately. |
| `medium` | Warns. Fails in strict mode if `ANVIL_STRICT_RISK_LEVEL=medium`. |
| `low` | Recorded but not flagged as a risk. |

Adjust severity to match your environment:

```bash
ANVIL_NETWORK_DIRECT_IP_SEVERITY=high
ANVIL_NETWORK_NON_STANDARD_PORT_SEVERITY=high
```

## Using the network monitor standalone

Run any command under network monitoring without the full observed mode install:

```bash
anvil-network-monitor -- npm test
```

This writes:

- `network-strace.log`
- `network-report.json`
- `network-report.md`

Useful for commands other than `npm ci` when you still want outbound connection evidence.

## Limitations

- `strace` requires the `SYS_PTRACE` capability in some container runtimes.
- macOS does not support `strace` natively. Use `dtrace` or run Node Base in a Linux container.
- Encrypted traffic contents are not decrypted. Only connection endpoints are recorded.
- Some network activity may happen before `strace` attaches.

## Read next

- [Observed mode](/docs/node-base/observed-mode)
- [Reports](/docs/node-base/reports)

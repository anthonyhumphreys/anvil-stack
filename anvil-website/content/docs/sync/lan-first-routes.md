---
title: LAN-first Mesh routes
navTitle: LAN-first routes
description: How Mesh prefers a host's LAN address, falls back to other routes, and moves a live session to a better route without replaying commands.
product: Anvil Sync & Mesh
section: Concepts
journey: learn
order: 45
---

# LAN-first Mesh routes

**Beta through 30 November 2026.**

When Desktop, the headless daemon or the native mobile app connects to one of your enrolled hosts, Mesh chooses the route for you. It tries the host's address on your local network first and falls back quickly when that address doesn't answer. When a better route appears, the live session switches only after a replacement has authenticated and caught up, and the switch never resends a command.

## Route order

1. **Host LAN-address candidates** that respond.
2. **Other private routes**, such as VPN or overlay addresses, or interfaces the host can't classify.
3. **Explicit HTTPS** endpoints.
4. **Managed ingress.** This needs a provisioned, enabled endpoint and passes traffic through the provider's proxy, so it is not peer-to-peer. Whether it is available depends on your deployment.

The host advertises its own addresses through your account backend. These hints set the order Mesh tries routes in; they are not trust. Identity, enrollment, endpoint generation and authorization checks apply to every route. Mesh does not scan subnets or add a discovery protocol, and other machines never get the host's loopback address.

## Choosing a route

Mesh first sends quick read-only probes to the advertised routes. Probes carry no account token or admission ticket, and they have short deadlines. Fallback probes get their own capacity, so several dead LAN addresses can't hold up a working HTTPS or managed route.

Mesh then authenticates one route at a time for each host, using fresh session keys. Late or abandoned attempts are closed.

## Moving to a better route

If a session is on a lower-priority route and a better one becomes reachable, for example when your laptop joins the host's network, Mesh prepares a replacement session alongside the working one:

- The replacement authenticates and catches up on the event stream before it takes over. If preparation fails, runs out of time or its buffer overflows, Mesh discards it and the working connection carries on serving requests.
- Requests already sent stay on their original connection until they finish or reach their deadline.
- Switching routes never replays a command. An uncertain result stays uncertain, and the operation's own receipts reconcile it where it has them.
- Only hosts that advertise ordered stream handoff are upgraded proactively. Older hosts keep their current route.

Leaving the network breaks the connection, so there is nothing to hand over from. Mesh reconnects through the next usable route and the UI reports the reconnection. If the stream can't be replayed across the break, ordinary recovery resynchronises and reports the gap. A request whose response was lost is shown as uncertain rather than retried.

## Network changes

- The host watches its interfaces while it is hosting or serving clients. It publishes changed addresses promptly; unchanged samples cause no backend writes.
- Connected clients refresh discovery when a route-change hint arrives, and on a bounded periodic timer that covers missed hints.
- Desktop wake and mobile foreground return trigger a fresh look at the available routes.
- Dwell times and backoff stop repeated network changes from causing connection flapping.
- In the background, the mobile app cancels any route preparation and keeps its current authorized session.

## What this is not

- **Not offline Mesh.** Your backend still admits every session and keeps authorizing it while the session lasts. If the backend is unreachable, new sessions fail and existing authorization expires on schedule, even on a working LAN.
- **Not proof of locality.** The `Direct` label means Mesh used an address the host reported as a LAN address. It does not prove that the operating system sent the traffic over a physical LAN.
- **Not an execution grant.** Route choice does not change worker opt-in, job placement or approvals. See [Mesh jobs](/docs/sync/mesh-jobs).

## Connection labels

Connection details show the route a session is using once it has authenticated and taken over. Endpoint URLs and credentials are never displayed. A failed upgrade attempt does not flash a disconnected status.

| Label | Meaning |
| --- | --- |
| Direct | An address the host reported as a LAN address. Details say *Host LAN address*. |
| Private Network | Another private or overlay address, or an interface the host couldn't classify. |
| Direct HTTPS | An HTTPS endpoint the host advertised. |
| Managed Tunnel | Managed ingress through the provider proxy. |

Backend authorization failures are reported separately from route unavailability.

## Clients covered

| Client | Behavior |
| --- | --- |
| Desktop and headless daemon | LAN-first selection, network monitoring and live session migration. |
| Native iOS and Android, account mode | The same route policy and migration. The iOS app declares local network access, which iOS may ask you to allow. If LAN routes are blocked, Mesh is designed to fall back to another route without repeated prompts; physical release-build checks of this are still pending. |
| Browser workspace | Keeps its HTTPS routing. |
| Locally paired companion | Keeps its own pairing transport. See [Companion surfaces](/docs/desktop/companion-surfaces). |
| Raycast | Gets the improved route selection, but not live session migration. |

Android permits plain HTTP and WebSocket connections to private IP addresses for this. Application URL restrictions still apply, broker credentials still need HTTPS, and machine sessions stay authenticated and end-to-end encrypted.

## Beta status and verification

Automated suites cover route ordering, bounded fallback, ordered replay before promotion, requests staying on their original connection, no command replay, session cleanup and mobile lifecycle cases, including encrypted loopback wire tests. Loopback tests don't measure physical LAN latency or platform permissions. Physical acceptance is still pending during the beta: a MacBook and a Mac mini switching on a shared LAN, plus local network permission and route switching on native iOS and Android release builds. Being in beta does not mean those checks have passed. Current Mesh limits are listed in [Status and limits](/docs/sync/status-and-limits).

## Reference

### Controls

| Setting | Effect |
| --- | --- |
| `ANVIL_MESH_ROUTE_UPGRADES=false` | Turns off proactive route upgrades in Desktop and the daemon. |
| `EXPO_PUBLIC_ANVIL_MESH_ROUTE_UPGRADES=false` | Build-time switch that turns off proactive upgrades in a native mobile build. |

Neither switch disables initial route selection or ordinary reconnects, and neither changes authorization. Turning upgrades off cancels any preparation in progress without interrupting a healthy session.

### Initial tuning values

These are starting values, tuned from physical results as they come in.

| Control | Value |
| --- | --- |
| Head start for preferred routes | 250 ms before lower-priority probes are eligible |
| Probe deadline, private routes | 1 second |
| Probe deadline, HTTPS and managed routes | 2 seconds |
| Probe concurrency | 3 per host, 8 per client |
| Authentication concurrency | 1 per host, 4 per client |
| Initial connection budget | 30 seconds |
| Upgrade preparation budget | 30 seconds, covering probe, authentication, subscription and catch-up |
| Replacement event buffer | 512 events or 2 MiB |
| Minimum dwell after promotion | 60 seconds |
| Failed-upgrade backoff | 30 seconds, doubling to 5 minutes, with jitter |
| Host interface sampling | Every 15 seconds while hosting or serving |
| Active-client discovery refresh | At most once every 60 seconds, with jitter |
| Session authorization | Refreshed every 30 seconds; maximum age 60 seconds |

### Protocol identifiers

- Hosts advertise `machine.stream-handoff/1` when they support ordered replay before live events, which proactive upgrades require.
- Account sockets opt in to `machine.routes-changed` hints with the `machine.routes-changed/1` socket feature. Hints carry enrollment IDs only, never addresses.

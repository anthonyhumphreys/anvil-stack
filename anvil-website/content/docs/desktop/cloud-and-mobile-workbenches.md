---
title: Cloud and mobile workbenches
navTitle: Cloud and mobile tools
description: Operate Anvil Cloud from Desktop and inspect the Expo companion app with Argent and simulator tooling.
product: Anvil Desktop
section: Specialist tools
journey: build
order: 121
---

# Cloud and mobile workbenches

The Cloud and Argent views are opt-in specialist tools. They wrap local CLIs and runtime checks in a workspace-aware interface while keeping command execution in the Electron main process.

## Cloud Workbench

Enable Cloud in Settings before it appears in navigation. Select a repository, refresh the detected CLI state, then run one of the supported commands:

| Group | Commands |
| --- | --- |
| Health | Doctor checks local runtime, ports, build artifacts, generated client state, and AWS preview configuration. |
| Build | Guard Check runs policy and TypeScript diagnostics without build output. Build Cell compiles and refreshes the manifest and generated client. |
| Runtime | Inspect Local, Lens URL, Local Logs, Local DB, Workflows, and Services read local runtime state. |
| Agents | Validate Agents, Agent Manifest, and Agent Sandboxes inspect mounted-agent contracts and compatibility. |

The workbench shows the exact command, working directory, duration, exit state, stdout, stderr, and parsed JSON when available. It does not hide a failed CLI result behind a success-coloured button.

## Remote Cloud execution

Desktop can store an encrypted connection to an authenticated Anvil Cloud execution endpoint. From that connection it can test access, list execution leases, and start a run from a committed read-only repository snapshot.

During a run, Desktop can read event batches, resolve approval requests, steer the execution with another message, collect the result, or terminate the lease. The selected authentication mode may use Codex or Cursor subscription-backed login inside the worker, or a cloud-managed provider.

Remote execution is separate from normal Chat and disabled by default. Review the uploaded commit, endpoint, authentication mode, requested approval, and returned evidence before acting on the result.

## Argent Workbench

Argent supports the Expo companion project under `anvil-app/mobile`. Its readiness checks cover the Node version, companion project, Argent CLI, Codex MCP registration, simulator or emulator, Metro, and Anvil's simulator preview.

Setup and maintenance commands can install the Argent CLI, initialize its MCP integration, update it, and list feature flags. These commands change local developer tooling, so inspect their displayed command before running them.

Argent also prepares evidence-focused prompts for an agent to:

- launch or attach to the app
- capture and verify a screenshot
- smoke-test a short interaction flow
- inspect console and native logs
- inspect a network request and response
- read the React and accessibility trees
- profile a slow interaction
- open and verify a deep link

The workbench copies or sends these prompts to Chat. The agent still needs a working Argent MCP connection and a reachable device.

## Simulator preview versus Argent

Use the embedded iOS simulator preview when you need to see the running app beside Chat. Use Argent when the task needs agent-controlled taps, screenshots, logs, network inspection, component state, or profiling.

Android device readiness is part of Argent. The embedded simulator preview is currently iOS-specific.

## Failure checks

If either workbench fails:

1. Confirm the selected repository or mobile project exists.
2. Read the readiness or CLI status before running a command.
3. Run the displayed command in a terminal when you need unfiltered output.
4. Check local authentication and provider tooling.
5. Send the command, exit code, and relevant stderr to Chat.

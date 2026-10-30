---
title: Agent tools (Mezair MCP)
navTitle: Agent tools
description: The tools Mezair gives every agent session over a local MCP endpoint, how they are scoped, and what each group does.
product: Mezair Desktop
section: Reference
journey: reference
order: 225
---

# Agent tools (Mezair MCP)

Every saved local chat gets a set of Mezair tools over the [Model Context Protocol](https://modelcontextprotocol.io): ask you a structured question, publish a review into the thread, read a dependency audit, start a workflow, and more. The same tools work across providers, so a review published by Codex and one published by Devin look and behave the same.

## How the endpoint works

- The main process hosts a **loopback** Streamable HTTP MCP endpoint. It only listens on `127.0.0.1`.
- Each session gets its own **bearer token**. A token is scoped to that session and dies with it.
- Codex-family sessions (Codex, OpenAI, Azure, LLMGateway) receive the endpoint through per-launch configuration overrides. Cursor and Devin receive it through their ACP `mcpServers` setting, over HTTP or a small stdio shim.
- Repository tools check that the repository belongs to the session's workspace before they do anything. An agent can't point a Mezair tool at a checkout outside its scope.

Your permission mode still applies. Tools that change state go through the same approvals as the rest of the session.

## Tool groups

| Group | Tools | What it's for |
| --- | --- | --- |
| Questions | `question_ask` | Ask you a structured question with suggested answers. The agent waits for your answer and receives it as data. Works for every provider and permission mode. |
| Reviews | `review_context`, `review_publish`, `review_patch` | Gather the diff and publish an inline review: chapters, risks and findings, updated in place as the review progresses. |
| Findings | `findings_publish`, `findings_patch` | Publish a findings list with severity, file and line, ready to hand back as tasks. |
| Security | `security_audit_run`, `security_findings` | Run the repository's security audit and read its findings. |
| Dependencies | `deps_list`, `deps_audit`, `deps_licenses`, `deps_sbom` | List packages, check advisories and licences, and produce an SBOM. |
| CI/CD | `cicd_analyze` | Read a pipeline and publish it as a graph with slow or failing legs called out. |
| Data | `data_show` | Show a table or chart inline. |
| Diagrams | `diagram_show`, `diagram_list`, `diagram_read`, `diagram_update` | Draw and revise diagrams in the thread. |
| Artifacts | `artifact_create`, `artifact_list`, `artifact_read`, `artifact_update` | Create durable documents. A newer version supersedes the older one in place. |
| Sketches | `sketch_publish`, `sketch_show`, `sketch_update`, `sketch_patch`, `sketch_snapshot`, `sketch_keep` | Quick sandboxed visual sketches you can keep as artifacts. |
| Surfaces | `surface_read`, `surface_action`, `surface_comments`, `surface_complete` | Read a published surface, respond to your comments and mark it complete. |
| Delegation | `delegation_discover`, `delegation_propose`, `delegation_read`, `delegation_stop` | Propose work for helper agents, follow it and stop it. Delegated results come back for review before they touch your checkout. |
| Workflows | `workflow_list`, `workflow_read`, `workflow_start` | Find and start a reusable workflow. |
| Factories | `factory_list`, `factory_read`, `factory_draft`, `factory_preview`, `factory_save`, `factory_activate`, `factory_control`, `factory_runs`, `factory_run_read`, `factory_run_control` | Draft and operate [software factories](/docs/desktop/software-factories). Activation still needs your confirmation. |
| Browser | `browser_navigate`, `browser_click`, `browser_type`, `browser_get_text`, `browser_get_html`, `browser_evaluate`, `browser_screenshot`, `browser_status` | Drive Mezair's built-in browser for local previews. |
| Skills | `mezair_skill_get` | Load a Mezair skill's instructions on demand. |

The catalogue is defined in the app's source under `mezair-app/src/main/agent-tools/` and `mezair-app/src/main/surfaces/kinds/`. To add a surface kind, see [Extending Mezair](/docs/desktop/extending-mezair).

## What agents can't do with these tools

- Reach another workspace's repositories.
- Read your provider credentials, Sync tokens or share URLs. Share links are bearer credentials and never enter model context.
- Approve their own requests. Approvals come from you, in the thread or from a companion device.

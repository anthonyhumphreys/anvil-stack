---
title: Knowledge tools
navTitle: Knowledge tools
description: Browse and update Confluence content, inspect ADRs, manage Draw.io diagrams, and prepare design tooling in Anvil Desktop.
product: Anvil Desktop
section: Guides
journey: build
order: 160
---

# Knowledge tools

Knowledge tools keep project explanations close to the repositories they describe. Their job is to expose drift and decisions, not create a second source of truth by accident.

## Documentation provider

The Documentation view supports Confluence, Notion, and Linear. Confluence pages can be browsed by space and parent page. Notion pages can be searched and opened in Notion. Linear documents can be listed across the workspace or filtered by project, then opened in Linear.

With a repository selected, Anvil can compare a document with current repository evidence, report its staleness, draft an update, and save the reviewed content back to the provider. It can also create pages in Confluence spaces, add Notion pages under the configured parent, or create Linear documents with an optional project association. Review generated content before saving because the model sees repository summaries, not every operational fact held by the team.

Linear documentation uses the API key from the active Linear work-item connection. Configure that connection in Work Items settings, then select Linear in Documentation settings. Confluence and Notion keep their own credentials and setup flows.

## Architecture decision records

The ADR view scans every repository in the active workspace for architecture decision records. It groups results by repository, supports search by title, filename, or status, and renders the selected record for reading.

ADRs remain ordinary repository files. Edit and review them through Git like other documentation. If the scanner finds none, check that the repository is connected and that the files use recognizable ADR naming and content.

## Draw.io diagrams

The Diagrams view stores diagram files with the selected repository. It can initialize the diagram directory, list diagrams, read or delete one, and open the file in Draw.io when the desktop integration is available.

Generation sends repository context and an optional existing diagram to the configured model, which returns a title and Draw.io XML. You can cancel an active generation. Open the result in the editor and check labels, relationships, and direction before treating it as architecture evidence.

## Repository and pull request visualisations

The Workspace view builds repository maps from indexed module relationships. The repository twin adds Git state and recent agent-run activity. Code Review can build a separate pull request visualisation from a provider diff.

These views answer different questions:

- repository maps describe the indexed code structure
- the repository twin shows structure alongside current change and work activity
- pull request visualisations explain the scope and relationships in one proposed change

Generated visualisations can go stale. Use the refresh control or force a new pull request visualisation when the underlying source changed.

## Design readiness

Design tooling checks whether the expected Figma MCP integration and frontend skill are available. Anvil can register the Figma MCP and install the frontend skill through its typed main-process APIs.

This prepares the agent toolchain. It does not authenticate a Figma account, invent design authority, or make a generated interface approved. Keep source designs and explicit product decisions attached to the work.

## A practical documentation loop

1. Inspect the repository and existing ADRs.
2. Check the external page for staleness.
3. Draft only the section whose behavior changed.
4. Verify commands, configuration keys, paths, and limitations against source.
5. Review the resulting page or diagram in its destination.
6. Commit repository-owned knowledge with the code change when appropriate.

---
title: Dojo analytics and coaching
navTitle: Dojo
description: Inspect workspace agent activity, usage coverage, failures, and coaching recommendations grounded in conversation history.
product: Anvil Desktop
section: Working guide
journey: build
order: 115
---

# Dojo analytics and coaching

Dojo helps you inspect how agent-assisted work is going in a workspace. It combines recorded execution activity with optional coaching reviews of conversation history. It supports Codex, Cursor, OpenAI, and Azure session attribution where the provider data is available.

## Inspect activity

Choose a period to inspect runs, providers, models, personas, and linked work items. Drill into the source thread to understand failures, retries, correction signals, tool activity, context compaction, and completion state.

Provider-reported token usage and text-based token estimates remain separate. Missing usage or model attribution stays unknown. Add model prices as USD rates per million input, cached-input, and output tokens to estimate cost where usage is available. These figures are not provider invoices and do not impose a spending limit.

Delivery markers are recorded explicitly for linked work items. A completed agent turn or goal does not by itself prove that a change shipped. Comparisons with earlier periods are descriptive; they do not establish that a prompt or model caused a better result.

## Run a coaching review

Run a one-off review without enabling a schedule, or enable scheduled reviews with a lookback period, cron expression, and timezone. Reviews are scoped to the selected workspace. Only one review runs for that workspace at a time.

The review sends metrics and a bounded sample of conversation text to the configured LLM route. Local storage does not mean the coaching analysis runs on-device. Consider the contents of those conversations when choosing the route and enabling scheduled review.

Reports can suggest prompt improvements, relevant curated skills, and drafted skills with evidence references. Follow the references back to the conversation and inspect the proposed instructions before using them.

## Track recommendations

Recommendations retain suggested, accepted, applied, or dismissed state. Recording an applied recommendation tracks your decision; it is not proof that the recommendation improved delivery. Keep weak suggestions dismissed and compare later evidence before adopting a broader change.

Failed or interrupted reports remain visible for inspection. A one-off review does not require turning on recurring processing.

See [Chat and agent runs](/docs/desktop/chat-canvas-and-agent-runs) for the underlying activity records and [Settings and diagnostics](/docs/desktop/settings-and-diagnostics) for provider configuration.

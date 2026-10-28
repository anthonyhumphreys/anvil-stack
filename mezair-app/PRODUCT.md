# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The desktop application uses an Electron host and a React interface. Native operating-system behaviour needs separate verification from browser previews.

## Users

Developers and independent delivery teams using Mezair as a desktop mission-control surface while they investigate repositories, direct coding agents, review changes, and monitor long-running work. They are usually mid-task and need the interface to preserve context without competing for attention.

## Product Purpose

Mezair brings repository-aware developer workflows, AI-agent sessions, reviews, security work, and operational tools into one workspace-scoped desktop application. Success means users can understand what is happening, act quickly, and trust that work and conversation state belong to the workspace currently in view.

## Positioning

The conversation carries native, actionable views of the work. Agents publish structured reviews, validation plans, diagrams and other results into the thread, where the user can inspect evidence and refine the work in the same conversation.

## Operating Context

Users work across local repositories, linked work items, agent conversations and saved workflows. Validation starts only when the user requests it or a workflow explicitly includes it. Expectations come from work-item acceptance criteria or the user's request and clarifications. Material ambiguity is resolved in conversation.

## Capabilities and Constraints

- Main-process services own repository access, permissions and persisted evidence; the renderer uses typed IPC.
- Inline surfaces have compact thread views and expanded evidence views. Validation does not have a separate Changes navigation section.
- Validation results identify the source snapshot and criteria. Changed source or expectations invalidate earlier evidence.
- Mezair-observed command results, agent-reported observations and human acceptance are separate facts.
- Existing review records remain accessible through chat and linked work items.

## Evidence on Hand

The repository contains service and renderer tests, synthetic chat replay fixtures, and candidate preview build tooling. Synthetic browser previews demonstrate interface behaviour; they do not establish native installation, physical-device or hosted-service acceptance. The user's rejected Changes screenshot and confirmed conversational validation flow guide the current replacement.

## Brand Personality

Pragmatic, focused, technically sharp. The interface should feel calm under load and confident without becoming theatrical.

## Anti-references

Avoid dashboard clutter, nested-card sprawl, decorative status chrome, hidden workspace boundaries, and chat transcripts fragmented by implementation details. Avoid corporate brochure language, glassmorphism, neon terminal cosplay, and motion without a state-change purpose.

## Product Principles

- Keep the user's current task and conversation dominant.
- Scope state visibly and correctly; workspace boundaries are a trust boundary.
- Disclose operational detail progressively instead of interleaving it with prose.
- Prefer familiar desktop affordances and keyboard-efficient flows.
- Make status legible, compact, and truthful.

## Accessibility & Inclusion

Target WCAG 2.2 AA for contrast and interaction. Support keyboard navigation, visible focus, reduced motion, text zoom, non-colour status cues, and resilient wrapping for long technical content.

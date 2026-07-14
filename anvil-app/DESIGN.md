---
name: Anvil
description: Focused developer mission control for repository-aware work.
colors:
  canvas: "#0b1020"
  surface: "#111827"
  surface-raised: "#172033"
  border: "#33415f"
  text-primary: "#f8fbff"
  text-secondary: "#cbd6e6"
  text-muted: "#95a3b8"
  accent: "#ff8a3d"
  success: "#48d597"
  warning: "#ffd166"
  info: "#5ec8ff"
  error: "#ff6b8a"
typography:
  title:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.4
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.xl}"
    padding: "6px 12px"
  field:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.xl}"
    padding: "10px 12px"
---

# Design System: Anvil

## Overview

**Creative North Star: "The Quiet Workbench"**

Anvil is a dark desktop product used for sustained technical work. Its interface uses restrained colour, compact controls, and clear tonal layers so the user's repository, conversation, and current operation remain obvious. Density is earned by utility; detail that is not needed now is progressively disclosed.

The system rejects dashboard clutter, nested-card sprawl, decorative status chrome, glass effects, neon terminal cosplay, and motion without purpose.

**Key Characteristics:**

- Dark, tinted canvas with two clear surface layers.
- IBM Plex Sans for interface copy and IBM Plex Mono for code and commands.
- Orange reserved for selection and primary action; semantic colours communicate state.
- Flat by default, with borders and tonal shifts doing most depth work.

## Colors

The base Anvil palette is cool navy with a restrained forge-orange accent. Brand variants may replace the token values, but their semantic roles stay fixed.

### Primary

- **Forge Orange** (`#ff8a3d`): current selection, primary action, and important focus cues.

### Neutral

- **Night Canvas** (`#0b1020`): application and conversation background.
- **Workbench Surface** (`#111827`): rails, toolbars, and secondary panes.
- **Raised Surface** (`#172033`): hover, selected-neutral, and nested control states.
- **Steel Border** (`#33415f`): structural separators and control outlines.
- **Primary Ink** (`#f8fbff`), **Secondary Ink** (`#cbd6e6`), **Muted Ink** (`#95a3b8`): information hierarchy.

### Named Rules

**The One Accent Rule.** Orange marks selection or action, never decoration.

## Typography

**Display Font:** IBM Plex Sans (system-ui fallback)

**Body Font:** IBM Plex Sans (system-ui fallback)

**Label/Mono Font:** IBM Plex Mono (ui-monospace fallback)

**Character:** Technical and readable, with weight and colour carrying hierarchy instead of oversized headings.

### Hierarchy

- **Title** (600, 14px, 1.4): panel names and important row titles.
- **Body** (400, 14px, 1.65): conversation prose, descriptions, and longer status copy; cap prose near 72ch.
- **Label** (500, 12px, 1.4): metadata, compact controls, and timestamps.
- **Mono** (400-500, 12-14px): commands, paths, identifiers, and code only.

### Named Rules

**The Conversation Rule.** Assistant prose is the strongest continuous reading surface; tool metadata must not fracture it.

## Elevation

Anvil is flat by default. Tonal layering and one-pixel borders establish structure; shadows are reserved for floating menus, overlays, and hover feedback that genuinely changes layer.

### Named Rules

**The Structural Depth Rule.** Do not add a shadow where a surface token or divider already explains the hierarchy.

## Components

### Buttons

- **Shape:** compact rounded rectangle using 8-12px radii.
- **Primary:** accent colour is rare and reserved for the primary action in the current context.
- **Hover / Focus:** tonal shift on hover; two-pixel accent focus ring with an offset.
- **Secondary / Ghost:** border or tonal background, with clear text hierarchy and no decorative shadow.

### Chips

- **Style:** compact semantic label with tinted background and matching text.
- **State:** combine colour with text or icon; never make colour the only signal.

### Cards / Containers

- **Corner Style:** 8-12px where containment is necessary.
- **Background:** canvas and workbench surface tokens.
- **Shadow Strategy:** flat at rest.
- **Border:** one-pixel structural border.
- **Internal Padding:** 12-16px, varied by content density.

### Inputs / Fields

- **Style:** canvas background, structural border, 12px radius.
- **Focus:** visible accent ring and border shift.
- **Error / Disabled:** semantic colour plus plain-language state; preserve entered content.

### Navigation

Use familiar desktop rails and toolbars. Active workspace, route, and thread must remain unambiguous. Collapse lower-priority actions before shrinking labels into ambiguity.

### Activity Group

Agent commands, file edits, reads, approvals, plans, and goals form one progressively disclosed activity surface per turn. It may summarize counts and failures, but it must not split assistant prose into sentence fragments.

## Do's and Don'ts

### Do:

- **Do** keep workspace-scoped state correct before rendering it.
- **Do** keep assistant prose near 72ch and visually quieter than user prompts without wrapping every fragment in a card.
- **Do** group operational events by turn and reveal command details on demand.
- **Do** retain visible keyboard focus, reduced-motion support, and non-colour status labels.

### Don't:

- **Don't** use dashboard clutter, nested-card sprawl, or decorative status chrome.
- **Don't** allow hidden workspace boundaries or stale cross-workspace content.
- **Don't** fragment chat transcripts with tool calls or streaming implementation details.
- **Don't** use glassmorphism, neon terminal cosplay, gradient text, or coloured side-stripe cards.
- **Don't** animate layout properties or add motion without a state-change purpose.

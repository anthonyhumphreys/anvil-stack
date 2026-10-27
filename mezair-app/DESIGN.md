---
name: Mezair
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

# Design System: Mezair

## Overview

**Creative North Star: "The Quiet Workbench"**

Mezair is a dark desktop product used for sustained technical work. Its interface uses restrained colour, compact controls, and clear tonal layers so the user's repository, conversation, and current operation remain obvious. Density is earned by utility; detail that is not needed now is progressively disclosed.

The system rejects dashboard clutter, nested-card sprawl, decorative status chrome, glass effects, neon terminal cosplay, and motion without purpose.

**Key Characteristics:**

- A monochrome horse-M identity, with may-ZAIR on introductory lockups.
- Dark, tinted canvas with two clear surface layers.
- IBM Plex Sans for interface copy and IBM Plex Mono for code and commands.
- Orange reserved for selection and primary action; semantic colours communicate state.
- Flat by default, with borders and tonal shifts doing most depth work.

## Colors

The base Mezair palette is cool navy with a restrained orange action accent. The horse-M identity is monochrome; introducing it does not change the existing action, selection, focus, or semantic theme colours. Brand variants may replace the token values, but their semantic roles stay fixed.

### Primary

- **Action Orange** (`#ff8a3d`): current selection, primary action, and important focus cues.

### Neutral

- **Night Canvas** (`#0b1020`): application and conversation background.
- **Workbench Surface** (`#111827`): rails, toolbars, and secondary panes.
- **Raised Surface** (`#172033`): hover, selected-neutral, and nested control states.
- **Structural Border** (`#33415f`): structural separators and control outlines.
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

**The Brand Lockup Rule.** The startup wordmark uses 44px as an intentional brand exception; it does not expand the normal interface type scale.

## Elevation

Mezair is flat by default. Tonal layering and one-pixel borders establish structure; shadows are reserved for floating menus, overlays, and hover feedback that genuinely changes layer.

### Named Rules

**The Structural Depth Rule.** Do not add a shadow where a surface token or divider already explains the hierarchy.

## Components

### Brand identity and startup lockup

The approved horse-M silhouette is the product identity. Reuse the canonical vector in `../branding/mezair-mark.svg`; the renderer copy is `src/renderer/assets/mezair-mark.svg`. Preserve all three paths and the source proportions. The renderer uses a mask in the surrounding text colour, so the mark is dark on light surfaces and light on dark surfaces. Keep the identity monochrome; action orange retains its existing functional role.

The introductory lockup combines the mark, a lowercase **mezair** wordmark, and **may-ZAIR** below it. The pronunciation belongs on the startup introduction and other introductory brand treatments, not every sidebar label. The sidebar keeps its compact mark and ordinary interface text.

The desktop startup surface uses the following component-specific values:

- The mark occupies a 176px square mask box and keeps the vector's proportions within it.
- The wordmark uses IBM Plex Sans at 44px, weight 700, line height 1, and tracking −0.03em. This is the intentional startup wordmark exception, not a new panel-heading size.
- The pronunciation uses IBM Plex Mono at 12px with tracking 0.08em and the secondary text colour. The wordmark and pronunciation have a 12px gap.
- A plain 12px status message states the current startup state. The enclosing surface is a polite live status region.
- The indeterminate progress track is a 2px hairline, at most 220px wide and otherwise 62vw, with fully rounded ends. Its 999px radius is an intentional exception for a thin progress line, not a container or control radius token. The monochrome moving segment occupies 40% of the track and inherits its rounded ends; the track uses the subtle border colour. It conveys activity, not a percentage or completion estimate, and is hidden from assistive technology because the status text owns the meaning.

The lockup rises 10px and fades into place once over 600ms with `cubic-bezier(0.16, 1, 0.3, 1)`. While startup is active, the progress segment moves horizontally in a restrained 1.3-second ease-in-out loop. Do not add rotation, bounce, colour cycling, or extra animated decoration to the mark. Under `prefers-reduced-motion: reduce`, both animations stop; the mark, name, pronunciation, status, and a static progress segment remain visible.

Video introductions may scale this same mark and wordmark to their composition. Native companion launch screens may use the static mark. The desktop startup sizes do not redefine mobile, video, or ordinary interface typography.

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

### Chat Composer

The chat composer is a focused surface-level exception to the general field shape. Its shell uses the tertiary background and a generous 28px radius; the message editor is 16px with a 26px line height, starts at 76px, grows with available width, and scrolls after reaching 200px. Give the text 18px top and 20px side insets; keep the focus border visible and use the existing semantic surface and text tokens so brand themes remain intact.

The footer keeps the access selector available beside a 36px ghost attachment control (Plus), with 4px between adjacent controls, model selection inline, and run settings compact. The primary send and stop actions are 40px circles. Send defaults to an ArrowUp icon; the mode menu retains the labeled Guide, Queue, and Side choices, and selecting a mode does not submit the draft. At composer widths below 600px, the toolbar wraps into two rows; at 420px and below, hide only the provider label while retaining the provider and model in the control's accessible name.

#### Save model

Settings and preference forms **autosave** — changes persist on change/blur
with a quiet tick/spinner indicator ("Saved", "Saving…") rather than a page-level
Save button. The exception is credential/secret forms, which use an explicit
Save action so secrets are only transmitted deliberately. Do not add "Save"
buttons to ordinary settings panels; do not autosave raw secrets on keystroke.

### Navigation

Use familiar desktop rails and toolbars. Active workspace, route, and thread must remain unambiguous. Collapse lower-priority actions before shrinking labels into ambiguity.

### Preview toolbar

Preview uses two compact rows. The first holds the Web/Simulator switch, a note toggle and window actions. Web navigation and the address field share the second row; Simulator shows its state, reload and start/stop controls. Agent connection setup and technical connection details live in menus. The note field opens only when requested. Keep controls usable at 320px pane width.

### Activity Group

Agent commands, file edits, reads, approvals, plans, and goals form progressively disclosed activity groups between conversation content. Keep answers, inline results, question receipts and subsequent activity in first-appearance order as text streams. Pending sends retain their place without becoming the owner of the executing turn's output. It may summarize counts and failures, but it must not split assistant prose into sentence fragments.

## Do's and Don'ts

### Do:

- **Do** keep workspace-scoped state correct before rendering it.
- **Do** keep assistant prose near 72ch and visually quieter than user prompts without wrapping every fragment in a card.
- **Do** group operational events by turn and reveal command details on demand.
- **Do** retain visible keyboard focus, reduced-motion support, and non-colour status labels.
- **Do** reuse the approved monochrome horse-M and reserve may-ZAIR for introductory lockups.

### Don't:

- **Don't** use dashboard clutter, nested-card sprawl, or decorative status chrome.
- **Don't** allow hidden workspace boundaries or stale cross-workspace content.
- **Don't** fragment chat transcripts with tool calls or streaming implementation details.
- **Don't** use glassmorphism, neon terminal cosplay, gradient text, or coloured side-stripe cards.
- **Don't** animate layout properties or add motion without a state-change purpose.
- **Don't** apply the 44px startup wordmark or fully rounded progress-line radius to ordinary interface elements.

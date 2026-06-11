---
name: Anvil Registry
description: Open source dependency security for npm installs, CI, and devcontainers.
colors:
  background: "#fbfcfc"
  foreground: "#14191a"
  surface-muted: "#f1f3f3"
  text-muted: "#5a6568"
  border: "#dde3e4"
  accent-forge: "#f48d1f"
  destructive: "#dc2828"
  dark-background: "#0f1415"
  dark-foreground: "#eef1f1"
  dark-surface: "#161c1d"
  dark-surface-muted: "#22292b"
  dark-text-muted: "#a7b2b4"
  dark-accent-forge: "#f59732"
  dark-border: "#2d3739"
typography:
  display:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "clamp(3rem, 8vw, 4.5rem)"
    fontWeight: 600
    lineHeight: 1.02
    letterSpacing: "normal"
  headline:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "2.25rem"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "normal"
  title:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "normal"
  body:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.75
    letterSpacing: "normal"
  label:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.25
    letterSpacing: "normal"
  code:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.75
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  section: "64px"
components:
  button-primary:
    backgroundColor: "{colors.foreground}"
    textColor: "{colors.background}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "40px"
  button-primary-large:
    backgroundColor: "{colors.foreground}"
    textColor: "{colors.background}"
    rounded: "{rounded.md}"
    padding: "8px 24px"
    height: "44px"
  button-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "40px"
  card:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    padding: "24px"
  badge-default:
    backgroundColor: "{colors.foreground}"
    textColor: "{colors.background}"
    rounded: "{rounded.md}"
    padding: "2px 10px"
---

# Design System: Anvil Registry

## 1. Overview

**Creative North Star: "The Maintainer's Forge"**

Anvil's design system is a clean OSS documentation surface with a forged-metal accent and a strong preference for proof over posture. It should feel like a capable maintainer showing the exact command, the policy decision, and the audit trail before making any claim about safety.

The system is restrained, technical, and documentation-forward. It uses quiet tinted neutrals, compact component vocabulary, clear borders, and one warm orange accent for security signal, icon emphasis, and small moments of brand heat. The public site can carry more visual identity than the future admin UI, but it should still earn trust through structure and specificity.

It explicitly rejects glossy cybersecurity vendor sludge, generic SaaS dashboard wallpaper, hacker-terminal cosplay, corporate DevSecOps content mulch, fake urgency, black-and-neon threat theatre, and heroic metrics with no receipts.

**Key Characteristics:**
- Documentation-first layout with code examples, policy evidence, and direct routes into setup.
- Restrained neutral surfaces with one warm accent, never a rainbow of security theatre.
- Light and dark themes that keep contrast high and avoid costume-like terminal aesthetics.
- Rounded 8px surfaces, visible borders, and minimal shadows for calm structure.
- Plain Inter typography paired with JetBrains Mono only for real commands and code.

## 2. Colors

The palette is near-neutral steel with a forge-orange accent: calm enough for docs, warm enough to feel owned.

### Primary
- **Steel Ink** (#14191a): Primary text, primary button backgrounds, active navigation emphasis, and the compact hammer mark.
- **Forge Orange** (#f48d1f): Accent for check icons, rings, selected badges, security signal points, and subtle code-window glow. Use sparingly so it reads as a deliberate signal.

### Neutral
- **Paper White** (#fbfcfc): Current light background and card surface, tinted slightly toward the steel neutral family.
- **Mist Surface** (#f1f3f3): Secondary and muted backgrounds, toolbar fills, code-panel headers, and quiet grouped areas.
- **Muted Steel** (#5a6568): Body support text, descriptions, secondary nav labels, and explanatory content.
- **Fine Border** (#dde3e4): Borders, dividers, table cells, outlines, and surface separation.
- **Night Steel** (#0f1415): Dark theme background and terminal-adjacent surfaces.
- **Night Surface** (#161c1d): Dark cards, popovers, and contained panels.
- **Night Muted Surface** (#22292b): Dark secondary and muted fills.
- **Night Text** (#eef1f1): Dark theme primary text.
- **Night Muted Text** (#a7b2b4): Dark theme descriptions and secondary text.
- **Night Forge Orange** (#f59732): Dark theme accent and focus ring.
- **Destructive Red** (#dc2828): Blocking, failure, and destructive states. Pair with text and iconography; never rely on red alone.

### Named Rules

**The Receipt Before Color Rule.** Color supports evidence, it does not replace it. A block, warning, quarantine, or override state must include clear text and, where helpful, an icon or label.

**The One Forge Rule.** Forge Orange is the brand heat. Keep it rare: icons, focus rings, selected states, and small signal points. Do not flood sections with orange unless designing a deliberate campaign moment.

## 3. Typography

**Display Font:** Inter with system sans fallbacks.
**Body Font:** Inter with system sans fallbacks.
**Label/Mono Font:** JetBrains Mono for command lines, JSON, package names, hashes, and terminal output.

**Character:** The type system is clean, direct, and utilitarian. Inter does the public-site work without becoming a brand performance; JetBrains Mono appears only when the content is actually code or command output.

### Hierarchy
- **Display** (600, `clamp(3rem, 8vw, 4.5rem)`, 1.02): Hero headlines and first-viewport positioning only.
- **Headline** (600, `2.25rem`, 1.1): Section headings and major docs page titles.
- **Title** (600, `1.125rem`, 1): Card titles, panel headings, and component-level headings.
- **Body** (400, `1rem`, 1.75): Marketing body copy, docs prose, and explanatory text. Keep prose around 65 to 75 characters per line where the layout allows it.
- **Small Body** (400, `0.9375rem`, 1.75): Documentation markdown and dense explanatory blocks.
- **Label** (500 to 600, `0.875rem`, 1.25): Navigation, buttons, badges, controls, and table labels.
- **Code** (400, `0.8125rem` to `0.875rem`, 1.75): Commands, JSON, package coordinates, hashes, and terminal output.

### Named Rules

**The Mono Earns Its Keep Rule.** Monospace is for code, command lines, JSON, package names, hashes, and terminal output. Do not use it as lazy shorthand for technical credibility.

**The No Shouting Rule.** Avoid repeated all-caps micro-labels. The current logo wordmark may stay uppercase, but section grammar should use normal sentence-case language.

## 4. Elevation

Anvil is mostly flat and bordered, with one soft ambient shadow for hero media and code panels. Depth is conveyed through borders, muted fills, sticky header blur, and careful spacing before shadows.

### Shadow Vocabulary
- **Anvil Ambient** (`box-shadow: 0 18px 55px rgba(14, 18, 22, 0.08)`): Use on hero imagery, code panels, and important media-like surfaces.
- **Card Soft** (`box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05)`): Current card default via `shadow-sm`. Use for ordinary bordered cards only.

### Named Rules

**The Flat By Default Rule.** Surfaces sit on the page through borders and tonal contrast. Shadows are for terminal panels, hero assets, and surfaces that need real priority.

## 5. Components

Components should feel compact, predictable, and maintainer-built. The site uses shadcn-style primitives with lucide icons, 8px cards, 6px buttons, visible borders, and fast color-state transitions.

### Buttons
- **Shape:** Rounded medium corners (`6px`) with stable heights (`40px` default, `44px` large, `40px` icon).
- **Primary:** Steel Ink background with Paper White text. Use for the main docs action and decisive navigation.
- **Hover / Focus:** Hover uses slight opacity shifts (`primary/90`, `secondary/80`) and focus uses a 2px Forge Orange ring with a 2px offset.
- **Secondary / Ghost / Tertiary:** Outline buttons use Fine Border on the current background. Ghost buttons appear in toolbars and icon controls, especially copy and theme actions. Link buttons are text-only and underlined on hover.

### Chips
- **Style:** Badges are compact (`2px 10px`), medium weight, 6px radius, and bordered by default.
- **State:** Default badges use Steel Ink. Secondary badges use Mist Surface. Destructive badges use Destructive Red and must include text that names the state.

### Cards / Containers
- **Corner Style:** Rounded large corners (`8px`).
- **Background:** Paper White or Night Surface with foreground text and Fine Border.
- **Shadow Strategy:** Ordinary cards may use Card Soft. Code panels and hero/media containers may use Anvil Ambient.
- **Border:** One-pixel borders are part of the vocabulary. Do not add colored side stripes.
- **Internal Padding:** Standard card padding is `24px`; compact feature rows may use `16px`; code content uses `20px`.

### Inputs / Fields
- **Style:** Input styling is tokenized through `--input`, `--background`, `--foreground`, and `--ring`, but form fields are not yet a major public-site component.
- **Focus:** Use the same Forge Orange ring as buttons.
- **Error / Disabled:** Disabled states use reduced opacity and no pointer events. Error states should pair Destructive Red with explicit text.

### Navigation
- **Style:** Sticky top header, 64px high, one-pixel bottom border, `bg-background/92`, and `backdrop-blur`.
- **Typography:** Brand mark uses `text-lg` and semibold weight; nav items use `text-sm font-medium`.
- **States:** Default nav text is Muted Steel; hover moves to Steel Ink. Mobile swaps full nav for icon buttons while preserving theme and docs access.
- **Theme:** The theme toggle cycles system, dark, and light with accessible labels and persistent local storage.

### Code Panels

Code panels are the signature component. They use a bordered card shell, muted toolbar, lucide terminal/copy icons, JetBrains Mono content, and the `code-window` background: a near-black diagonal gradient with a subtle Forge Orange radial glow. Commands use amber text and output stays readable on dark surfaces.

### Documentation Markdown

Docs prose uses `15px` text with relaxed leading, section headings with visible top borders, underlined links, inline code pills, bordered tables, and preformatted blocks on Night Steel. This is the clearest expression of the system's OSS reader bias: text, commands, and tables must be easier to scan than the layout is to admire.

## 6. Do's and Don'ts

### Do:
- **Do** lead with concrete commands, policy decisions, install flows, analysis artefacts, and audit trails before abstract claims.
- **Do** keep Forge Orange (#f48d1f / #f59732) rare and meaningful: focus rings, icons, selected states, and small security signals.
- **Do** use visible one-pixel borders (#dde3e4 light, #2d3739 dark) to structure sections, cards, docs tables, and controls.
- **Do** preserve strong contrast in both themes and pair security states with text, iconography, and color.
- **Do** keep documentation routes, quickstart paths, Docker Compose, CI, and Node Base usage close to the surface.
- **Do** use JetBrains Mono only for actual code, command output, hashes, package names, and JSON.

### Don't:
- **Don't** make Anvil feel like glossy cybersecurity vendor sludge, generic SaaS dashboard wallpaper, hacker-terminal cosplay, or corporate DevSecOps content mulch.
- **Don't** use inflated claims, fake urgency, black-and-neon threat theatre, vague compliance language, or heroic metrics with no receipts.
- **Don't** make the site look like a crypto security product, a venture-backed observability clone, or a dark terminal skin stretched over a marketing page.
- **Don't** use colored side-stripe borders on cards, list items, alerts, or callouts. Use full borders, tinted backgrounds, icons, or labels.
- **Don't** use gradient text, decorative glassmorphism, or identical card grids as the main design answer.
- **Don't** let color alone communicate allow, warn, quarantine, block, or override states.

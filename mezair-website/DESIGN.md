# Intent

Mezair should feel like a precise workspace: calm, inspectable, and built for real engineering work. The site earns trust by showing the tools working, not by describing them.

The signature is **the workbench**: an authored, scroll-built view of Mezair Desktop doing a real job — open a repo, hand an agent a task, review the change, hand it on. Everything else on a page stays quiet so that one moment carries the story. Secondary visuals are **living schematics**: hairline diagrams of the real mechanism (devices, sealed envelopes, jobs) whose motion reads as the system running. If a visual could not be mistaken for something in the repo's own docs or app, it is too glossy.

# Identity

The monochrome horse-M mark is the Mezair identity. It follows the text colour in light and dark themes without decorative effects. The name is pronounced **may-ZAIR**; introduce that pronunciation in the homepage copy, not in every navigation label.

# Colors

Light is the primary theme; dark follows the system or the toggle. Both use a cool neutral (hue ~250), never warm cream.

```yaml
paper: oklch(0.986 0.004 240)      # page ground
ink: oklch(0.2 0.015 250)          # text, headings
muted: oklch(0.5 0.02 250)         # secondary text
rule: oklch(0.9 0.008 250)         # borders and dividers
accent: oklch(0.72 0.18 52)         # primary action, live state, orientation
artifact-dark: oklch(0.16 0.014 250)  # bounded artifacts: app window, terminals, code, schematics
```

The orange action accent is the primary action fill (with ink text) and the live/working state. It never fills large backgrounds or decorative gradients. Encrypted or sealed state is marked with the accent plus a word, never colour alone.

Dark artifact surfaces are reserved for bounded artifacts: the workbench window, terminals, code panels and schematics. They are content, not page backgrounds, and look the same in both site themes.

# Typography

One family, two voices. **Archivo** set wide and heavy (`wdth` 112–118, weight 700, tracking −0.025em) is the display voice for page and section headings only. Archivo at normal width (400/500/600) is the text and interface voice. **JetBrains Mono** marks commands, code, paths and machine output only; it is never a decorative "technical" label.

Body copy is 17px with 1.65 line height and a measure under 70ch. Headings carry their own weight: no eyebrows, kickers, all-caps labels, section numbers, or middle-dot meta strings. Orientation comes from copy.

# Layout

Left-aligned throughout. Content sits on a 12-column grid with a 76rem max width. Section headings hang in a left column (about a third) with the content to their right on large screens; on small screens they stack. Lists and divided rows carry comparisons; cards are reserved for bounded interactive objects. Borders do more work than shadows. Product pages include status, ownership, working proof and task paths.

Use an 8px rhythm with 4px adjustments for compact controls. Public sections get generous vertical space; documentation navigation stays dense enough to scan. Touch targets are at least 44px.

# Components

- **Workbench stage**: a dark artifact app window built in HTML/CSS, labelled as an illustration. Its states change with scroll on large screens and render as a sequence of stills on small screens.
- **Schematic diagrams**: authored inline SVG with hairline strokes, one glyph weight, dashed routes for in-flight work and mono annotations pinned to what they describe.
- **Terminal panels**: real commands with honest status words (`pass`, `ready`), never ticker theatre.
- **Buttons**: primary is accent-filled with ink text; secondary is a ruled outline. Arrows appear only on links that move you forward to a new place, not on every button.
- **Docs**: code blocks are dark artifact with a copy button; notes and warnings are tinted callouts with a word label; every page links to its source on GitHub.

# Interaction

Motion is brief and functional, with three authored exceptions: the workbench's step transitions and its live activity edge, the schematic's in-flight envelopes, and the terminal's typed output. Ambient loops pause off-screen and stop entirely under reduced motion; nothing essential is conveyed by motion alone. Search opens with `/` or Command/Ctrl-K. Every action has a visible keyboard focus state.

# Voice

Write for a developer deciding whether to try this today. Plain verbs, second person, short sentences, sentence case. Say what the thing does and what it costs. Be honest about what is alpha or not yet available, in one clear sentence rather than a pile of qualifiers. If a sentence could appear on any SaaS site, rewrite it.

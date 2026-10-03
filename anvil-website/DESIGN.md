# Intent

Anvil should feel like a precise workshop: calm, inspectable, and built for real engineering work. The interface uses proof and structure to create confidence, with small moments of forge-orange warmth.

The signature visual language is the **living schematic**: technical diagrams of the real mechanism — devices, sealed envelopes, jobs, keys — drawn with hairline rules, monospace annotations, and motion that reads as the system actually running. Marketing pages show the mechanism working, not illustrations of the mechanism. If a visual could not be mistaken for something in the repo's own docs, it is too glossy.

# Colors

```yaml
background: oklch(0.991 0.006 205)
foreground: oklch(0.18 0.014 205)
muted: oklch(0.955 0.008 205)
muted-foreground: oklch(0.49 0.025 205)
accent: oklch(0.74 0.18 58)
border: oklch(0.895 0.013 205)
```

Use orange for orientation, state, and the primary action. Do not spread it across large backgrounds or decorative gradients. Sealed/encrypted state in diagrams is marked with the accent plus a word — `sealed`, `AES-256-GCM` — never colour alone.

Deep forge-dark surfaces (`oklch ~0.14–0.17`) are reserved for bounded artifacts: terminal windows, code panels, and schematic canvases. They are content, not page backgrounds; both site themes keep the same artifact treatment so a code window looks like a code window in light and dark mode alike.

# Typography

Archivo is the interface and editorial face. JetBrains Mono marks commands, repositories, paths, measurements, and machine output — it is not used as a decorative "technical" costume. Headings are compact and balanced. Documentation body copy stays at 16px or larger with a readable line length.

Headings carry their own weight: no eyebrow, kicker, or section-number labels above them. Orientation comes from copy, not from a label strip.

# Spacing

Use an 8px base rhythm with 4px adjustments for compact controls. Public sections use generous vertical space; documentation navigation remains dense enough to scan. Touch targets are at least 44px.

# Components

Navigation uses active states, `aria-current`, linked breadcrumbs, and product-local grouping. Cards are reserved for bounded interactive objects; lists and divided rows carry most comparisons. Borders do more work than shadows. Product pages must include status, ownership, working proof, and task paths.

**Schematic diagrams** are authored inline SVG: hairline strokes, node glyphs drawn at one consistent weight, dashed routes for in-flight work, mono annotations pinned to the elements they describe. Envelopes in flight render as small sealed packets; the backend is drawn as what it is — a relay that sees shapes, not content.

**Terminal panels** render real command output with honest status words (`pass`, `valid`, `sealed`), never stock ticker theatre.

# Interaction

Motion is brief and functional — with two authored exceptions: the schematic's in-flight envelopes and the terminal's typed output may loop gently, because a system at rest tells the truth about being a system. Everything else animates once or not at all. Search opens with `/` or Command/Ctrl-K. Respect reduced-motion preferences: ambient loops stop entirely, nothing essential is conveyed by motion alone. Every action must have a visible keyboard focus state.

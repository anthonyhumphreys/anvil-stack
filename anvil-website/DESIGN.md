# Intent

Anvil should feel like a precise workshop: calm, inspectable, and built for real engineering work. The interface uses proof and structure to create confidence, with small moments of forge-orange warmth.

# Colors

```yaml
background: oklch(0.991 0.006 205)
foreground: oklch(0.18 0.014 205)
muted: oklch(0.955 0.008 205)
muted-foreground: oklch(0.49 0.025 205)
accent: oklch(0.74 0.18 58)
border: oklch(0.895 0.013 205)
```

Use orange for orientation, state, and the primary action. Do not spread it across large backgrounds or decorative gradients.

# Typography

Archivo is the interface and editorial face. JetBrains Mono marks commands, repositories, paths, and machine output. Headings are compact and balanced. Documentation body copy stays at 16px or larger with a readable line length.

# Spacing

Use an 8px base rhythm with 4px adjustments for compact controls. Public sections use generous vertical space; documentation navigation remains dense enough to scan. Touch targets are at least 44px.

# Components

Navigation uses active states, `aria-current`, linked breadcrumbs, and product-local grouping. Cards are reserved for bounded interactive objects; lists and divided rows carry most comparisons. Borders do more work than shadows. Product pages must include status, ownership, working proof, and task paths.

# Interaction

Motion is brief and functional: disclosure chevrons, result entrances, focus changes, and directional arrows. Search opens with `/` or Command/Ctrl-K. Respect reduced-motion preferences. Every action must have a visible keyboard focus state.

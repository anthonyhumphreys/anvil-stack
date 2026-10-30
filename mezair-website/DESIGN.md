---
name: "Mezair website"
description: "A precise reading workspace and a cinematic projection room lit by real captures of working developer tools."
colors:
  reading-light-ground: "oklch(0.986 0.004 245)"
  reading-light-text: "oklch(0.2 0.016 255)"
  reading-light-card: "oklch(0.997 0.002 245)"
  reading-light-muted: "oklch(0.47 0.02 255)"
  reading-light-rule: "oklch(0.9 0.009 252)"
  reading-light-primary: "oklch(0.68 0.19 48)"
  reading-light-action-ink: "oklch(0.18 0.016 255)"
  reading-light-accent: "oklch(0.66 0.19 46)"
  reading-dark-ground: "oklch(0.165 0.014 258)"
  reading-dark-text: "oklch(0.94 0.006 250)"
  reading-dark-card: "oklch(0.2 0.016 258)"
  reading-dark-muted: "oklch(0.73 0.016 252)"
  reading-dark-rule: "oklch(0.31 0.018 258)"
  reading-dark-action: "oklch(0.76 0.17 54)"
  reading-artifact-light: "oklch(0.17 0.03 265)"
  reading-artifact-dark: "oklch(0.13 0.025 265)"
  cine-ground: "oklch(0.135 0.03 266)"
  cine-card: "oklch(0.175 0.03 264)"
  cine-text: "oklch(0.965 0.006 250)"
  cine-muted: "oklch(0.77 0.02 255)"
  cine-rule: "oklch(0.3 0.03 262)"
  cine-action: "oklch(0.76 0.17 54)"
  cine-action-ink: "oklch(0.16 0.03 266)"
  cine-window: "oklch(0.168 0.033 266)"
  cine-raised: "oklch(0.212 0.035 263)"
  cine-scene-text: "oklch(0.96 0.008 255)"
  cine-scene-dim: "oklch(0.76 0.024 255)"
  cine-scene-accent: "oklch(0.77 0.17 53)"
  cine-ok: "oklch(0.8 0.15 158)"
  cine-key-light: "oklch(0.36 0.08 262)"
  cine-warn: "oklch(0.86 0.13 86)"
  cine-del: "oklch(0.73 0.15 22)"
  meaning-ground: "oklch(0.135 0.022 265)"
  meaning-text: "oklch(0.96 0.008 250)"
  meaning-muted: "oklch(0.73 0.018 255)"
  meaning-rule: "oklch(0.3 0.024 260)"
  meaning-action: "oklch(0.77 0.16 55)"
typography:
  display:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2.5rem, 1.3rem + 3.7vw, 4.4rem)"
    fontWeight: 740
    lineHeight: 0.96
    letterSpacing: "-0.03em"
    fontVariation: "\"wdth\" 116"
  headline:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2rem, 1.35rem + 2.3vw, 3.4rem)"
    fontWeight: 720
    lineHeight: 1
    letterSpacing: "-0.028em"
    fontVariation: "\"wdth\" 116"
  reading-display:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2.6rem, 1.4rem + 5.2vw, 5.6rem)"
    fontWeight: 720
    lineHeight: 0.98
    letterSpacing: "-0.028em"
    fontVariation: "\"wdth\" 116"
  body:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.0625rem"
    lineHeight: 1.65
    fontVariation: "\"wdth\" 100"
  doc-body:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.0625rem"
    lineHeight: 1.75
  lede:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.0625rem, 1rem + 0.3vw, 1.1875rem)"
    lineHeight: 1.55
  label:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 600
    lineHeight: 1.3
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "0.8125rem"
    lineHeight: 1.75
rounded:
  control: "calc(0.625rem - 2px)"
  artifact: "0.625rem"
  panel: "0.75rem"
  window: "16px"
  pill: "999px"
spacing:
  shell-x: "1.25rem"
  shell-x-wide: "2rem"
  action-gap: "0.75rem"
  scene-gap: "1rem"
  content-gap: "1.5rem"
  title-column-gap: "3rem"
components:
  button-primary:
    backgroundColor: "{colors.reading-light-primary}"
    textColor: "{colors.reading-light-action-ink}"
    rounded: "{rounded.control}"
    padding: "0.5rem 1rem"
    height: "2.5rem"
  button-primary-marketing:
    backgroundColor: "{colors.cine-action}"
    textColor: "{colors.cine-action-ink}"
    rounded: "{rounded.control}"
    padding: "0 1.5rem"
    height: "3rem"
  button-outline:
    backgroundColor: "{colors.reading-light-ground}"
    textColor: "{colors.reading-light-text}"
    rounded: "{rounded.control}"
    padding: "0.5rem 1rem"
    height: "2.5rem"
  button-ghost:
    textColor: "{colors.reading-light-muted}"
    rounded: "{rounded.control}"
    padding: "0.5rem 1rem"
    height: "2.5rem"
  search-field:
    textColor: "{colors.reading-light-text}"
    height: "3.5rem"
  branch-chip:
    textColor: "{colors.cine-scene-dim}"
    rounded: "{rounded.pill}"
    padding: "0.1rem 0.55rem"
  scene-turn-card:
    backgroundColor: "color-mix(in oklch, oklch(0.212 0.035 263) 55%, oklch(0.168 0.033 266))"
    textColor: "{colors.cine-scene-text}"
    rounded: "{rounded.panel}"
    padding: "0.65rem 0.8rem"
  scene-window:
    backgroundColor: "{colors.cine-window}"
    textColor: "{colors.cine-scene-text}"
    rounded: "{rounded.window}"
  reel-tab:
    textColor: "{colors.cine-muted}"
    padding: "0.65rem 0.25rem 0.35rem 0"
  navigation-link:
    textColor: "{colors.reading-light-muted}"
    rounded: "{rounded.control}"
    padding: "0 0.75rem"
---

# Design System: Mezair website

## Overview

**Creative North Star: "The projection room and the workbench"**

Mezair shares one identity across two visual worlds: a calm, inspectable reading workspace and a dramatic projection room where real captures of the working product carry the marketing. Both use cool neutrals, Archivo, the monochrome horse-M and a restrained orange action accent. The mark follows the text color.

The always-dark projection room covers `/`, `/sync`, `/pricing` and `/what-does-mezair-mean`. The naming page is its quieter identity expression: power under precise control, with strength, discipline, progression and elegance expressed through the large horse-M and a visitor-triggered hop. Docs, account, workspace, auth and shared-artifact routes retain their existing reading and operating styles; the cinematic scope does not replace them.

**Key Characteristics:**

- Cool neutral grounds, a single action accent and explicit status words.
- Wide, heavy display type paired with normal-width interface text.
- Real Desktop captures with fixture data, labelled motion diagrams, divided comparisons and quiet reading surfaces.
- Purposeful motion with pause controls, reduced-motion support and static initial frames.

This document records the final source in `app/globals.css`, `app/marketing.css`, `app/mark.css`, `app/what-does-mezair-mean/meaning.module.css`, the shared UI components, the marketing components and the social cards in `app/_og/`. Tokens above are normative. The sidecar adds source metadata, preview specimens, motion and responsive rules. Route-specific story and composition remain in `.impeccable/surfaces/app-page-tsx.md`.

## Colors

Cool paper and navy grounds give the same orange accent two contexts: quiet orientation in reading surfaces and live work in the projection room. Names in this section refer to the frontmatter tokens.

### Primary

- **Light action orange** fills the shared primary button; **Light detail orange** supplies the light theme’s links, focus and smaller accents. These are distinct source values.
- **Night action orange** supplies both primary and accent roles in the shared dark theme.
- **Live orange** supplies marketing actions and progress. **Scene live orange** is the slightly different accent inside the Mesh stage diagrams.
- **Naming orange** is the naming page’s local action variation.

### Secondary

- **Completed green**, **Attention yellow** and **Deletion red** encode scene state and diff meaning. They accompany words, icons or diff markers rather than carrying meaning alone.

### Neutral

- **Cool paper / Reading ink** and **Reading night / Night text** are the shared light and dark reading pairs. Card, muted-text and rule tokens belong to the matching theme.
- **Light-theme artifact navy** and **Dark-theme artifact navy** keep code, terminals and diagrams bounded and dark; their ground changes with the reading theme.
- **Projection navy** is the marketing ground. **Projection board** holds the plans object. **Window navy / Raised window navy** define the staged app’s interior layers; scene text and scene secondary text are separate from page text.
- **Cool key light** is a low-opacity radial pool behind a staged object. It is atmosphere, never text fill.
- **Naming navy** and its text, muted and rule tokens override the corresponding marketing roles on the naming page. Its other roles continue inheriting the cinematic palette.

**The Scope Rule.** Keep the cinematic palette inside the marketing wrapper. Reading and operating routes retain their established theme bindings.

The marketing wrapper locally overrides shared semantic variables, so buttons, navigation and footer inherit its dark palette. The document root also takes a dark color scheme and navy overscroll ground while that wrapper exists. The workspace’s existing `.mezair-chat-theme` continues binding its operating UI to the imported Desktop chat tokens; the shared reading tokens are not a replacement for that palette.

## Typography

**Display and body:** Archivo, with sans-serif fallbacks. **Code and operational detail:** JetBrains Mono, with monospace fallbacks. Font files are configured in `app/layout.tsx`.

The width axis supplies the contrast: heavy, wide display type has the presence of a title card; normal-width body and interface type stays direct and readable.

- **Display:** the marketing hero role in frontmatter, wide at 116, with a compact line height and a measure up to 15ch.
- **Headline:** the marketing section role, also wide at 116, with a more open line height.
- **Reading display:** the shared display utility; smaller shared heading sizes retain the same wide voice.
- **Body / Doc body:** shared text uses the body role; long-form documentation increases line height to the doc-body role.
- **Lede:** marketing summaries use the lede role, within 46ch. Fine text is smaller, with room for honest limits.
- **Label:** reel chapter labels use normal-width semibold type. Interface labels stay sentence case.
- **Mono:** commands, paths, code and operational details use the mono voice. Scene interiors use compact sizes to match an application rather than a headline.

The naming hero uses the shared wide display voice with its own larger size (`clamp(3rem, 6.7vw, 6rem)`), a 12ch measure, and a mobile size of `clamp(3rem, 11vw, 4.5rem)`.

**The Display Rule.** Use wide Archivo for headings and large prices; keep body and interface text at normal width.

Social cards cannot use the variable font, so `app/_og/fonts/` holds static Archivo instances: width 125 at 800, registered with satori as **Archivo Expanded** for titles, and Medium 500 as **Archivo** for descriptions, with JetBrains Mono Medium for labels. They are the same family as the site's display and body voices, not new typefaces.

## Layout

The shared shell is centered and capped at 76rem; cinematic stages use an 88rem shell. Both begin with 1.25rem horizontal padding and increase to 2rem at 640px. The spacing primitives above record repeated source distances, rather than implying a new global spacing scale.

Marketing title rows stack, then become an 8:5 grid at 1024px. Stage spacing and section padding are fluid. The homepage opens on a centred title card (painted mark, H1, lede, actions) above a 16:10 reel of real captures; the Sync page and the homepage's Sync section use the Mesh stage; pricing uses one ruled plans board. Use cases pair a step list with one sticky capture stage from 1024px and stack each step with its own capture below it. The homepage credits form a role/value list around a center gutter from 768px; this is a specific authored pattern, not the alignment rule for every page.

The Mesh stage switches from its wide 1000×476 layout to a tall 400×720 layout when its own width drops below 620px, so labels stay legible on phones. Reel and stage chapter tabs are four across, and two by two below 480px. Plans use one column, two from 768px, and four from 1280px. Comparison and billing rows similarly gain columns at 768px.

The naming page uses the shared shell, a 1.2:1 introduction grid, a large centered horse-M and a divided caption. At 700px and below, introduction, caption and afterword stack. Its arena height and mark size are fluid. Keep all content usable at the confirmed 390px mobile target.

## Elevation & Depth

Reading surfaces rely primarily on tone and borders. Bounded artifacts and navigation overlays retain their existing local shadows. Capture frames (`.reel-frame`, `.shot`, the use-case stage) and the Mesh stage add a long, dark, offset shadow and a faint inset highlight; the cool radial key light places them in the room. The plans board uses a related long shadow. A contained surface gradient inside the Mesh stage provides lighting without introducing glass.

Exact shadow declarations are in the sidecar’s elevation extensions. Its component specimens carry the complete CSS that the frontmatter’s limited component schema cannot represent.

**The Lit Object Rule.** Reserve cinematic depth for product windows and staged objects. Keep comparisons and explanatory lists divided and quiet.

## Shapes

Shared controls use the computed control radius from the global radius token. Content panels use a gently curved 0.75rem corner, staged windows use 16px, and branch or agent chips use fully rounded ends. The scene’s turn cards use the panel radius; smaller scene controls have their own compact corners. Borders are thin and descriptive, defining ownership, panes and comparison rows. The horse-M remains a crisp monochrome silhouette with no decorative fill or glow.

## Components

### Buttons and links

Primary actions are orange with dark text, a semibold label, a shallow inset/drop shadow and a 150ms color response. The shared default is 40px tall; marketing’s large action is 48px tall. Outline actions use the current ground with an input-colored border; hover shifts the border and muted surface. Ghost actions begin in muted text. Keyboard focus uses a two-pixel ring and offset; the shared button moves down one pixel on press. Do not infer a universal 44px minimum from the default 40px button: navigation and dedicated icon controls explicitly use 44px targets.

Marketing prose links have a fine orange underline that changes to foreground on hover. Use arrows where they clarify a destination or the naming page’s playful action.

### Navigation

The sticky header uses a translucent themed ground, a bottom rule and backdrop blur. Desktop navigation appears at 1024px; a menu replaces it below that point. Current-page and hover links become foreground; keyboard focus receives the ring. Marketing and naming routes pass `showThemeToggle={false}` because their palette is always dark.

### Search field and documentation

Documentation search is a 56px-tall, transparent field within a ruled dialog header, with muted placeholder text and an accent search icon. Its wrapper, result selection and close control provide the interaction structure; the bare input does not acquire an invented standalone border. Search opens with `/` or Command/Ctrl-K. Documentation code blocks use bounded dark artifact panels with copy controls; notes, tips and warnings use labeled tinted callouts.

### Real captures

Every product image is the production Mezair Desktop UI rendered with synthetic fixture content (the Acme workspace, Dana's devices, example jobs). `scripts/capture-screens.mjs` captures the Electron shell and the `mezair-app` replay harness over the DevTools protocol, writes 2× WebP to `public/screens/` and records each capture's source, fixture, size and app commit in `manifest.json`. `lib/screens.ts` pairs every capture with alt text that describes the screen in words and a short caption. Never draw product UI in the website; add a replay fixture instead. Docs reference captures with `![alt](/screens/id.webp "caption")`, which renders a sized, lazy `.doc-figure`.

### Product reel

The homepage reel crossfades four real captures (Watch it work, Read the result, Review the change, Move machines) inside one 16:10 frame. Full-window captures cover the frame from the top-left; panel captures sit centred on the window ground. A keyboard tablist with a filling orange line selects chapters; autoplay runs only while on screen, in a visible tab and without reduced motion, and any choice holds that chapter. Slides cross 700ms on opacity, 900ms on scale (1.012 → 1) and 700ms on a 6px blur. Where `animation-timeline: view()` is supported and motion is allowed, the frame tilts up from `rotateX(14deg) scale(0.94)` into place as it scrolls in. Its caption names the capture and links to how captures are made.

### Mesh stage

One SVG stage, four stories: Sync (an edit is sealed, relayed as ciphertext and opened on two devices), Mesh job (pinned commit, durable record, lease, live stream back, credentials staying on the worker), LAN-first routes (LAN probed first, fallback to the next route that answers, the returning route authenticating and catching up before the switch) and Handoff (the seven real `HandoffState` values, a sealed checkpoint and the generation moving 4 → 5). Devices, commits and output are fixture content; order, states and limits follow `cloud/contract`. A `requestAnimationFrame` clock advances only on screen, in a visible tab and without reduced motion; chapter choice plays once and holds; reduced motion and the server render show each chapter's key frame. Each chapter has a text summary for assistive tech, a caption with the current beat in words, and an ordered beat list. Orange marks live movement, green completion, yellow attention and red failure, always with words.

### Animated mark

`<AnimatedMark>` paints the canonical horse-M in the manner of sumi-e, left to right. A dry-brush ground line draws first. One continuous brush gesture follows: up from the tail's tip, over into the valley, up the neck and a firm stop at the muzzle. The foreleg is laid as that brush passes the shoulder, with a flick of ink at the hoof. Bristles run ahead of the body of ink for dry-brush streaks, a turbulence filter gives the edges paper fibre, ink pools where the brush lands, and a blurred wet bleed dries into the crisp mark. A settle layer then seals the exact geometry. The horse then makes one collected rise as a single rigid body, pivoting on the tail's tip, while only the separate foreleg folds. It lands slightly forward on a sampled spring. The whole entrance takes about 3.6s and is monochrome. Every keyframe fills backwards only, so the resting mark is the base style for no-JS, reduced motion and the end state. Pressing it replays. Any mark inside `.mk-hover` (header, footer, hero) tilts up 3.5° as one body, with the foreleg folding 10°, on hover or focus. Never alter the geometry or move its shapes independently, except the foreleg about its shoulder. Brush centrelines live in `mark-geometry.ts`.

### Social cards

`app/_og/card.tsx` renders 1200×630 cards with satori: projection navy (sRGB equivalents of the OKLCH tokens), the wide Archivo display voice, mono labels, the mark, and a real capture bleeding off the right edge where the page has one. Every public route has `opengraph-image` and `twitter-image` files; documentation pages get `/og/docs/<slug>` from a route handler because catch-all segments cannot hold metadata image files. `lib/metadata.ts` gives each public page matching title, description, canonical, Open Graph and Twitter fields.

### Plans and divided rows

Pricing is one rounded, ruled board rather than detached cards. The featured column receives a subtle orange tint and a two-pixel top edge; wide Archivo gives prices their hierarchy. The bill ledger, backend comparisons and companion list use divided rows. FAQs use native disclosure controls with a plus rotating when open. Availability and pricing limits remain visible beside the action they qualify.

### Naming and horseplay

`/what-does-mezair-mean` gives the name a visual expression of controlled power. The large horse-M sits above a hairline ground. “A little horseplay” triggers a single 1.2s collected hop; there is no entrance autoplay. The caption changes through a polite live region. Reduced motion removes the hop and button transition while preserving the action and text feedback.

## Do's and Don'ts

### Do:

- Do keep the horse-M monochrome and bound to the surrounding text color.
- Do use the scoped marketing palette on all four cinematic routes and keep their theme toggle hidden.
- Do use real captures with fixture data for every product image, with alt text that describes the screen, and label motion diagrams as fixture content.
- Do pair operational colors with text.
- Do keep chapter selection, pause controls, keyboard focus and reduced-motion behavior available.
- Do preserve the naming page’s click-triggered horseplay and its power-under-control character.

### Don't:

- Don't carry cinematic page styling into docs, account or workspace routes.
- Don't use gradient text, decorative glass, drawn or composited product UI, fake metrics or testimonials.
- Don't replace divided comparisons with a repetitive grid of equal icon cards.
- Don't add decorative eyebrows, kickers or machine-looking labels to marketing headings.
- Don't turn the orange accent into a large decorative background or convey status through color alone.

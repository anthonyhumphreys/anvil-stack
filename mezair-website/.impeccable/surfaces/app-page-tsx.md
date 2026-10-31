---
version: 1
slug: "app-page-tsx"
primary_target: "app/page.tsx"
related_targets: ["app/sync/page.tsx","app/pricing/page.tsx","app/what-does-mezair-mean/page.tsx"]
---

# Marketing surfaces: /, /sync, /pricing

Mode: Persuade. Docs, account, workspace, auth and artifact routes are out of scope and keep the light/dark docs world.

## Audience, job, actions
- Developer or tech lead deciding whether to try Mezair Desktop today, and whether hosted Sync is worth requesting.
- Actions: Download for Mac (unsigned; install guide), Windows/Linux releases, view MIT source, request hosted Sync beta (invite-only through `featureBeta.endDate`), redeem beta code, self-host Sync, read docs.
- Proof: real captures of Mezair Desktop with synthetic fixture content (Electron shell and the mezair-app replay harness; provenance in `public/screens/manifest.json`), plus labelled motion diagrams of Sync & Mesh whose states and ordering follow `cloud/contract`.

## Direction contract
THESIS: The product is the projection. Each page opens on a lit, working Desktop capture in a dark room; copy is a title card, not the content. Refuses the long textual hero, the four-screen scroll tutorial and the icon-card feature grid.
OWN-WORLD: Desktop navy ground (oklch ~0.135 0.03 266), app windows as the only lit objects with a cool key light beneath, orange accent only for live/working state and primary action. Archivo wide heavy display, JetBrains Mono only for commands/paths/states. Credits-roll lists (role | value around a centre gutter) replace feature grids.
STORY: See an agent take a task, work, get reviewed, and move machines; see what people hand to it; understand how Sync & Mesh behave; believe it runs locally on your accounts with honest limits; download or request beta.
FIRST VIEWPORT: The painted horse-M, a short H1, a two-sentence lede and Download/Source actions, centred; the capture reel begins within the first viewport at 1440×900 with a four-chapter strip (Watch it work, Read the result, Review the change, Move machines). Do not add screenshot-production captions or links; maintenance instructions stay in the repository.
FORM: Cinematic projection room, selected by the user. Surface seed:9647261274d71f28; the user-pinned cinematic direction governs over generated alternatives.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

## Signature interactions
- The mark: one sumi-e entrance painted left to right (ground, one continuous stroke through tail and neck, foreleg as the brush passes the shoulder, drying ink), then a collected rise as one rigid body; replayable on press. A small rigid rise on hover or focus wherever the mark appears in `.mk-hover`.
- The reel: a keyboard tablist of four real captures that autoplays while on screen with a filling progress line, stops on any user choice, pauses offscreen/hidden tab, and never autoplays under reduced motion. The frame tilts into place on scroll where supported.
- The Mesh stage: one stage, four stories (Sync, Mesh job, LAN-first routes, Handoff) on a continuous clock with the same gating; each chapter has a text summary, a captioned current beat and the ordered beat list. /sync uses it as the hero; the homepage repeats it in the Sync section.
- Use cases: a step list beside one sticky capture stage on wide screens; inline captures on narrow screens.

## Constraints
- No drawn or composited product UI. Product images are real captures with fixture data; motion graphics are diagrams and say so.
- Keep truthful limits: free local Desktop, unsigned Mac builds need the install guide, bring your own provider accounts, hosted Sync invite-only beta, proposed prices not purchase, self-host free but host bills separately, Cloud Agents unavailable. Chat threads run in the chosen checkout; workflows, helpers, factories and Mesh jobs use worktrees.
- No private financial forecasts. No gradient text, decorative glass, fake metrics or testimonials. No horizontal overflow from 320px.
- Marketing styles live in app/marketing.css, every selector under `.cine`; the mark lives in app/mark.css.

## Additional confirmed direction
- Pricing is up front and said the same way everywhere, in one or two sentences: the app is free; Sync & Mesh is free on a backend you run (your cloud provider bills you) or £6 a month if Mezair hosts it; hosting is an invite-only beta for now. On the homepage it sits under the lede, before the download action.
- The footer links to a playful naming page. Its story is power under precise control: strength, discipline, progression and elegance. The user sets the direction; agents carry out complex, coordinated work. A click-triggered horse-M hop retains the fun.
- Logo motion: "Ink draw + rise", chosen by the user, refined to sumi-e brushwork painted smoothly left to right. The silhouette never comes apart.

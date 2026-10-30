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
- Proof: authored, labelled HTML scenes of Desktop states grounded in mezair-app renderer vocabulary (thread states, Working/Work completed card, "N files changed", Commit/Open PR, "Session on X — state", real `HandoffState` machine from cloud/contract/handoff.ts).

## Direction contract
THESIS: The product is the projection. Each page opens on a lit, working Desktop scene in a dark room; copy is a title card, not the content. Refuses the long textual hero, the four-screen scroll tutorial and the icon-card feature grid.
OWN-WORLD: Desktop navy ground (oklch ~0.135 0.03 266), app windows as the only lit objects with a cool key light beneath, orange accent only for live/working state and primary action. Archivo wide heavy display, JetBrains Mono only for commands/paths/states. Credits-roll lists (role | value around a centre gutter) replace feature grids.
STORY: See an agent take a task, work, get reviewed, and move machines; believe it runs locally on your accounts with honest limits; download or request beta.
FIRST VIEWPORT: Short H1 + one-sentence lede + Download/Source actions, the scene window starting within the first ~45% of an 891px-wide viewport, a four-chapter reel strip (Task, Agent work, Review, Handoff) under it, illustrative-demo label beside it.
FORM: Cinematic projection room, selected by the user. Surface seed:9647261274d71f28; the user-pinned cinematic direction governs over generated alternatives.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Signature interaction
The reel: a keyboard tablist of four chapters that autoplays while on screen with a filling progress line, stops on any user choice, pauses offscreen/hidden tab, and never autoplays under reduced motion. Each chapter has a text summary for assistive tech. /sync reuses the handoff stage as its hero, stepping through the real handoff states.

## Constraints
- No fake screenshots; every scene labelled as an illustrative HTML demo with example repo/devices.
- Keep truthful limits: free local Desktop, unsigned Mac builds need the install guide, bring your own provider accounts, hosted Sync invite-only beta, proposed prices not purchase, self-host free but host bills separately, Cloud Agents unavailable.
- No private financial forecasts. No gradient text, decorative glass, fake metrics or testimonials. No horizontal overflow at 390px.
- Marketing styles live in app/marketing.css, every selector under `.cine`.

## Additional confirmed direction
- The footer links to a playful naming page. Its story is power under precise control: strength, discipline, progression and elegance. The user sets the direction; agents carry out complex, coordinated work. A click-triggered horse-M hop retains the fun.

## Unresolved
- Real Desktop screenshots could later sit beside the authored scenes as evidence.

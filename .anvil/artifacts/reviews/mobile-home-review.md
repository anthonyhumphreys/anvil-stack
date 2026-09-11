The original home mixed backlog browsing with agent supervision. Work items pushed urgent actions below the fold, healthy sessions appeared under “Needs you,” and the backlog silently stopped at eight items.

The revised home prioritises attention, running agents, and recent conversations. Work items retain search and sprint filters on a separate virtualised list. Reviews and security remain accessible from Home. Stop controls remain inside threads.

Implementation:
- anvil-app/mobile/app/(tabs)/index.tsx
- anvil-app/mobile/app/work-items.tsx
- anvil-app/mobile/lib/home-summary.ts

Validation:
- 569 tests passed, including four new home-summary regression tests.
- Mobile lint and standard typecheck passed.
- iOS and Android JavaScript exports passed.
- Native iOS build succeeded.
- Inspected dark-mode Home and work items on an iPhone simulator.

Limits: the simulator's saved pairing token was invalid, so live approvals and agent actions were not exercised. iPad, Android device layouts, and enlarged text still need visual verification.

Impeccable flagged legacy PRODUCT.md metadata. An optional init refresh can update that record; it was left unchanged.
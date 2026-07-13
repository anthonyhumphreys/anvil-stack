# Mobile thread-tap navigation fix

## Diagnosis

Touch delivery is working on the Threads screen: rows visibly enter their pressed state.

The failing paths all call `router.push`. The confirmed-working deeplink calls `router.navigate`. Expo Router 57 converts these into different navigation actions while resolving the NativeTabs navigator and its nested Chats Stack.

The Work screen’s missing pressed feedback is separate: its rows use a static style and therefore cannot visually represent the pressed state.

## Proposed implementation

1. Add one canonical typed thread-route helper using the explicit grouped route:

   `/(tabs)/chats/[threadId]`

2. Route every thread entry point through `router.navigate`:

   - Threads list
   - Work → Active work
   - Work → Recent
   - Work → Needs you
   - Any other thread-opening shortcut found during the focused search

3. Reuse the same route helper in deeplink parsing where practical, preventing the manual and external navigation paths from drifting again.

4. Give Work rows functional pressed styling matching the Threads cards.

5. Keep the existing direct native `Pressable`; do not reintroduce the `Link asChild` composition that previously broke functional styles.

## Verification

1. Run mobile TypeScript and Expo lint.
2. Export the iOS bundle to catch route-generation failures.
3. Install a development/device build first.
4. Manually verify:

   - Tap a row from Threads.
   - Return using the native back button.
   - Tap a Recent thread from Work.
   - Tap an active-session thread from Work.
   - Open a thread deeplink.
   - Confirm each path shows the correct thread ID and preserves expected back-stack behavior.

5. If `navigate` unexpectedly fails, stop rather than stacking additional routing guesses. Add temporary route/action instrumentation and capture the native navigation state from the device.

6. Once taps pass, build and install the full signed Release bundle with the Watch app and widget still embedded.

## Acceptance criteria

- Every tappable thread row opens its corresponding thread on the first tap.
- Threads and Work rows provide visible pressed feedback.
- Native back navigation returns to the originating list.
- Deeplinks continue to work.
- No duplicate thread-detail screens accumulate.
- Watch and widget targets remain present and signed.
- No new navigation framework or test dependency is introduced for this narrow regression.
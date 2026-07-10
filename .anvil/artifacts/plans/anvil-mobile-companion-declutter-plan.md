# Anvil mobile companion declutter plan

Status: Review and implementation plan only  
Goal: Make the companion a focused mobile work surface for selecting a workspace, starting or resuming meaningful work, and steering it away from the main machine.

## Verdict

The companion is not demoware under the bonnet. It already supports remote runs, threads, approvals, attachments, file mentions, skills, workspace health, multiple hosts, widgets, Live Activities, and Watch actions.

The interface still presents those capabilities like a catalogue. Home duplicates large parts of Work, Chats, and Approvals, while workspace selection still depends on the Mac. The app therefore feels busy when connected and strangely empty when disconnected.

The new product hierarchy should be:

**Host → Workspace → Needs attention → Active work → New task**

Everything else is supporting detail.

## Evidence from the current implementation

1. **Workspace selection is the critical functional gap.**

   [`MobileOverview`](</Users/anthonyhumphreys/Code/anvil/anvil-app/src/shared/types.ts:890>) already returns every workspace, and [`MobileStartChatInput`](</Users/anthonyhumphreys/Code/anvil/anvil-app/src/shared/types.ts:862>) already accepts a workspace ID. However, Home tells the user to select a workspace on the Mac in [`index.tsx`](</Users/anthonyhumphreys/Code/anvil/anvil-app/mobile/app/(tabs)/index.tsx:236>), and the client exposes no workspace-selection operation.

2. **The navigation contains five top-level destinations with substantial overlap.**

   [`_layout.tsx`](</Users/anthonyhumphreys/Code/anvil/anvil-app/mobile/app/(tabs)/_layout.tsx:33>) exposes Home, Approvals, Chats, Work, and Settings. Home contains a composer, health dashboard, quick starts, recent runs, hosts, and work queue. Chats contains another composer, while Work repeats health and launch actions.

3. **Active work is not sufficiently live.**

   A thread reloads when its route ID changes in [`[threadId].tsx`](</Users/anthonyhumphreys/Code/anvil/anvil-app/mobile/app/(tabs)/chats/[threadId].tsx:80>), but companion events only refresh the overview in [`companion-context.tsx`](</Users/anthonyhumphreys/Code/anvil/anvil-app/mobile/contexts/companion-context.tsx:353>). Agent output can therefore remain stale until a manual refresh.

4. **Message drafts can be lost on failure.**

   The thread composer clears its draft before awaiting the request in [`[threadId].tsx`](</Users/anthonyhumphreys/Code/anvil/anvil-app/mobile/app/(tabs)/chats/[threadId].tsx:130>). The new-thread composer also clears after a failed workflow returns `null`. Mobile network errors must not eat typed work.

5. **The workspace model is tied too closely to desktop state.**

   [`getMobileOverview`](</Users/anthonyhumphreys/Code/anvil/anvil-app/src/main/services/mobile-companion.service.ts:861>) resolves and can update the desktop active workspace. A mobile choice should be scoped to the paired host and must not move the desktop user into another workspace.

6. **Accessibility is currently release-blocking.**

   The fresh simulator build at an accessibility text size wrapped “Anvil” into separate fragments, expanded the setup card beyond the viewport, and displaced navigation. A source scan also found no explicit accessibility roles, labels, hints, or states across roughly 80 custom interactive controls.

## Product model

The physical scene is someone checking work one-handed on a train, sofa, or lunch break while their Mac remains elsewhere. They need clear state, safe actions, and quick recovery from unreliable connectivity.

Apple’s current guidance similarly recommends concentrating on primary tasks, limiting visible controls, and using tabs only for stable top-level sections: [Designing for iOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-ios), [Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars).

### Proposed navigation

Use three tabs:

1. **Work**
   - Default destination.
   - Selected workspace.
   - Needs attention.
   - Running sessions.
   - Recent resumable work.
   - One clear “New task” action.

2. **Threads**
   - Searchable conversation history.
   - Current workspace by default.
   - Optional “All workspaces” scope.
   - No second full composer at the top.

3. **Inbox**
   - Approvals, blocked sessions, failures, and other items requiring intervention.
   - Global across workspaces, with workspace and repository labels.
   - Pending-count tab badge.

Move pairing, host management, native surfaces, and manual connection into a settings route opened from the top-right toolbar. Settings is infrastructure, not a daily destination.

### Persistent workspace control

Every primary screen gets a compact header:
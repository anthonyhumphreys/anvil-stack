# Role-Based Onboarding & Feature Subsetting

## Overview

Add a two-role onboarding experience to Anvil. On first launch, users pick their role (Developer or BA/BRM). The role determines which features appear in the sidebar. Users can change their role at any time from Settings.

## Roles & Feature Visibility

```typescript
type UserRole = 'developer' | 'ba-brm';

const ROLE_FEATURES = {
  developer: ['repos', 'chat', 'onboard', 'workitems', 'security', 'codereview', 'docs', 'diagrams'],
  'ba-brm': ['repos', 'chat', 'workitems', 'docs', 'diagrams'],
} as const;
```

- **Developer**: All features (full nav).
- **BA/BRM**: Repos, Chat, Work Items, Documentation, Diagrams.
- **Always visible** (not in the map): Settings.
- **BA view** (`/ba/:workItemId`): Not a sidebar nav item — accessed from Work Items. Maps to the `workitems` feature key for route protection purposes. Available whenever `workitems` is enabled.

## Data Model & Persistence

Role is stored via the existing SQLite settings system. The `AppSettings` interface gets a new optional field:

```typescript
interface AppSettings {
  // ... existing fields
  userRole?: UserRole;
}
```

- Read: `const settings = await window.anvil.settings.get()` → `settings.userRole`
- Write: `await window.anvil.settings.update({ userRole: 'developer' })`

No new tables or schema changes.

## Onboarding Overlay

### Trigger

`App.tsx` checks the loaded settings on mount. If `userRole` is `undefined`, render `RolePickerOverlay` instead of the normal `<Shell>` layout.

### Component: `RolePickerOverlay`

**Location:** `src/renderer/components/onboard/RolePickerOverlay.tsx`

**Layout:** Full-screen overlay with centered content:
- App branding at top (name + subtitle from BrandContext)
- Subtitle: "What best describes your role?"
- Two stacked role cards, each showing:
  - Role icon and name
  - Inline feature list (e.g., "Chat · Work Items · Docs · Diagrams")
  - Right arrow indicator
- Clicking a card persists the role and dismisses the overlay

**Behavior:**
- Single click selects role, calls `await window.anvil.settings.update({ userRole: role })`, sets local state to render `<Shell>` instead
- No multi-step wizard, no animations
- No back button (user can change role in Settings later)

## Sidebar Filtering

### Changes to `Sidebar.tsx`

- Accept `userRole` prop (fetched in `Shell.tsx` alongside `connectionStatus`)
- Each nav item gets a `feature` key matching the keys in `ROLE_FEATURES`
- Filter: `navItems.filter(item => ROLE_FEATURES[role].includes(item.feature))`
- Settings button is outside the nav list and always visible

### Route Protection in `App.tsx`

`App.tsx` fetches settings on mount and holds `userRole` in state (same place the onboarding overlay check lives). Routes are defined in `App.tsx` as children of the `<Shell>` layout route. Each route element is wrapped in a check:

- Map each route path to its feature key (e.g., `/security/:repoId?` → `'security'`, `/ba/:workItemId` → `'workitems'`)
- If `ROLE_FEATURES[userRole]` doesn't include that feature, render `<Navigate to="/repos" />` instead of the component
- `userRole` state is passed to `Shell` as a prop so it can forward to `Sidebar`

## Settings — Role Switcher

### Changes to `SettingsView.tsx`

- Add a "Role" section at the top (before LLM Provider)
- Two-button selector showing Developer and BA/BRM
- Active role is visually highlighted
- Clicking the other role calls `settings.update({ userRole: newRole })` and updates local state
- No confirmation dialog — switching is instant

### Role Change Propagation

`userRole` state lives in `App.tsx` (where the onboarding check and route protection already need it). `App.tsx` passes `userRole` and an `onRoleChange` callback down through `Shell` to `SettingsView` via the route outlet context.

When the user clicks a different role in Settings:
1. `SettingsView` calls `await window.anvil.settings.update({ userRole: newRole })`
2. `SettingsView` calls the `onRoleChange(newRole)` callback
3. `App.tsx` updates its `userRole` state
4. `Shell` and `Sidebar` re-render immediately with the new role — no navigation required

## Component Tree Changes

```
App.tsx
├── RolePickerOverlay (if no role set)
└── Shell (if role set)
    ├── Sidebar (filtered by role)
    └── Routes (protected by role)
```

## Files Changed

| File | Change |
|------|--------|
| `src/shared/types.ts` | Add `UserRole` type, `ROLE_FEATURES` constant |
| `src/shared/ipc-api.d.ts` | Add `userRole` to `AppSettings` interface |
| `src/renderer/App.tsx` | Role check on mount, conditional overlay vs Shell, route protection |
| `src/renderer/components/onboard/RolePickerOverlay.tsx` | **New** — full-screen role picker |
| `src/renderer/components/layout/Shell.tsx` | Fetch and pass `userRole` to Sidebar |
| `src/renderer/components/layout/Sidebar.tsx` | Accept `userRole` prop, filter nav items |
| `src/renderer/components/settings/SettingsView.tsx` | Add Role section at top |

## Out of Scope

- **ADO Remote Repo Browser & Clone** — separate feature, will be its own spec/plan

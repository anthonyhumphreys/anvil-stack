# Role-Based Onboarding Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a two-role onboarding flow (Developer / BA-BRM) that gates sidebar navigation and routes based on the selected role, with the ability to switch roles from Settings.

**Architecture:** Role is stored as a new `userRole` field on the existing `AppSettings` interface, persisted via SQLite settings. `App.tsx` owns `userRole` state, shows a full-screen role picker overlay when unset, and passes role + callback down through `Shell` to `Sidebar` and `SettingsView`. Sidebar filters its nav items against a static `ROLE_FEATURES` map.

**Tech Stack:** React, React Router, TypeScript, Electron IPC, SQLite (existing settings store), Tailwind CSS

**Source root:** `/Users/anthonyhumphreys/Code/innovation/exploration/devhub/` (NOT `/video/` — that's a Remotion sub-project)

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/shared/types.ts` | `UserRole` type, `ROLE_FEATURES` constant, `userRole` field on `AppSettings` |
| `src/shared/ipc-api.d.ts` | Already declares `AppSettings` via import — no changes needed here |
| `src/renderer/App.tsx` | `userRole` state, onboarding gate, route protection, `onRoleChange` callback |
| `src/renderer/components/onboard/RolePickerOverlay.tsx` | **New** — full-screen role selection overlay |
| `src/renderer/components/layout/Shell.tsx` | Accept + forward `userRole` prop to `Sidebar` |
| `src/renderer/components/layout/Sidebar.tsx` | Filter nav items by role using `ROLE_FEATURES` |
| `src/renderer/components/settings/SettingsView.tsx` | Role switcher section, `onRoleChange` callback |

---

### Task 1: Add UserRole type and ROLE_FEATURES to shared types

**Files:**
- Modify: `src/shared/types.ts:288-332` (AppSettings interface)

- [ ] **Step 1: Add UserRole type and ROLE_FEATURES constant**

At the bottom of `src/shared/types.ts` (after `DiagramFile`), add:

```typescript
// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export type UserRole = 'developer' | 'ba-brm';

export const ROLE_FEATURES: Record<UserRole, readonly string[]> = {
  developer: ['repos', 'chat', 'onboard', 'workitems', 'security', 'codereview', 'docs', 'diagrams'],
  'ba-brm': ['repos', 'chat', 'workitems', 'docs', 'diagrams'],
} as const;
```

- [ ] **Step 2: Add userRole to AppSettings**

In the `AppSettings` interface (line ~330, before the closing `}`), add:

```typescript
  userRole?: UserRole;
```

- [ ] **Step 3: Verify the build compiles**

Run: `cd /Users/anthonyhumphreys/Code/innovation/exploration/devhub && npx electron-vite build 2>&1 | tail -20`
Expected: Build succeeds with no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(onboarding): add UserRole type and ROLE_FEATURES map"
```

---

### Task 2: Create RolePickerOverlay component

**Files:**
- Create: `src/renderer/components/onboard/RolePickerOverlay.tsx`

- [ ] **Step 1: Create the RolePickerOverlay component**

```tsx
import { useBrand } from '../../contexts/BrandContext';
import type { UserRole } from '../../../shared/types';
import { ROLE_FEATURES } from '../../../shared/types';

const ROLE_LABELS: Record<string, string> = {
  repos: 'Repositories',
  chat: 'Chat',
  onboard: 'Onboarding',
  workitems: 'Work Items',
  security: 'Security',
  codereview: 'Code Review',
  docs: 'Documentation',
  diagrams: 'Diagrams',
};

interface RoleOption {
  role: UserRole;
  label: string;
  description: string;
}

const ROLES: RoleOption[] = [
  { role: 'developer', label: 'Developer', description: 'Full access to all tools' },
  { role: 'ba-brm', label: 'BA / BRM', description: 'Docs, diagrams, chat & work items' },
];

interface RolePickerOverlayProps {
  onRoleSelected: (role: UserRole) => void;
}

export function RolePickerOverlay({ onRoleSelected }: RolePickerOverlayProps) {
  const brand = useBrand();

  const handleSelect = async (role: UserRole) => {
    await window.anvil.settings.update({ userRole: role });
    onRoleSelected(role);
  };

  return (
    <div className="flex h-screen items-center justify-center bg-bg-primary">
      <div className="titlebar-drag fixed inset-x-0 top-0 h-10" />
      <div className="w-full max-w-md space-y-6 px-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-accent">{brand.appName}</h1>
          <p className="mt-1 text-sm text-text-secondary">What best describes your role?</p>
        </div>

        <div className="space-y-3">
          {ROLES.map(({ role, label, description }) => {
            const features = ROLE_FEATURES[role]
              .map((f) => ROLE_LABELS[f] ?? f)
              .join(' · ');
            return (
              <button
                key={role}
                onClick={() => handleSelect(role)}
                className="flex w-full items-center gap-4 rounded-lg border border-border bg-bg-secondary p-4 text-left transition-colors hover:border-accent hover:bg-accent/5"
              >
                <div className="flex-1">
                  <div className="text-base font-semibold text-text-primary">{label}</div>
                  <div className="mt-0.5 text-sm text-text-tertiary">{description}</div>
                  <div className="mt-2 text-xs text-text-tertiary">{features}</div>
                </div>
                <span className="text-text-tertiary">&rarr;</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify the build compiles**

Run: `cd /Users/anthonyhumphreys/Code/innovation/exploration/devhub && npx electron-vite build 2>&1 | tail -20`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/onboard/RolePickerOverlay.tsx
git commit -m "feat(onboarding): add RolePickerOverlay component"
```

---

### Task 3: Wire up App.tsx with role state, onboarding gate, and route protection

**Files:**
- Modify: `src/renderer/App.tsx:1-170`

- [ ] **Step 1: Add role state and settings fetch**

Add imports at the top of `App.tsx`:

```typescript
import { RolePickerOverlay } from './components/onboard/RolePickerOverlay';
import type { UserRole } from '../shared/types';
import { ROLE_FEATURES } from '../shared/types';
```

Inside the `App` function, after the `connectionStatus` state declaration (line ~27), add:

```typescript
const [userRole, setUserRole] = useState<UserRole | null>(null);
const [roleLoaded, setRoleLoaded] = useState(false);
```

Inside the `checkConnections` callback, after `const settings = await window.anvil.settings.get();` (line ~31), add:

```typescript
if (settings.userRole) {
  setUserRole(settings.userRole);
}
setRoleLoaded(true);
```

Also add `setRoleLoaded(true)` in the `catch` block so the app falls through to the onboarding overlay if settings fail to load:

```typescript
} catch {
  setRoleLoaded(true); // Fall through to onboarding overlay
```

- [ ] **Step 2: Add role change handler**

After the `checkConnections` callback, add:

```typescript
const handleRoleChange = useCallback((role: UserRole) => {
  setUserRole(role);
}, []);
```

- [ ] **Step 3: Add onboarding gate and route protection**

Replace the return JSX. Before the `<HashRouter>`, add a loading/onboarding gate:

```tsx
if (!roleLoaded) {
  return null; // Wait for settings to load
}

if (!userRole) {
  return (
    <BrandProvider>
      <RolePickerOverlay onRoleSelected={handleRoleChange} />
    </BrandProvider>
  );
}
```

For the main return, create a helper function above the `return` to wrap route elements with role protection:

```typescript
const guard = (feature: string, element: JSX.Element) =>
  ROLE_FEATURES[userRole].includes(feature) ? element : <Navigate to="/repos" replace />;
```

Then update the Shell route to pass `userRole` and `onRoleChange`:

```tsx
<Route element={<Shell connectionStatus={connectionStatus} userRole={userRole} onRoleChange={handleRoleChange} />}>
```

And wrap each route element with the guard:

```tsx
<Route path="/repos" element={<ErrorBoundary><ReposView /></ErrorBoundary>} />
<Route path="/chat" element={guard('chat', <ErrorBoundary><ChatView /></ErrorBoundary>)} />
<Route path="/onboard" element={guard('onboard', <ErrorBoundary><OnboardView /></ErrorBoundary>)} />
<Route path="/workitems" element={guard('workitems', <ErrorBoundary><WorkItemsView /></ErrorBoundary>)} />
<Route path="/ba/:workItemId" element={guard('workitems', <ErrorBoundary><BaView /></ErrorBoundary>)} />
<Route path="/security/:repoId?" element={guard('security', <ErrorBoundary><SecurityView /></ErrorBoundary>)} />
<Route path="/codereview/:repoId?" element={guard('codereview', <ErrorBoundary><CodeReviewView /></ErrorBoundary>)} />
<Route path="/docs" element={guard('docs', <ErrorBoundary><DocsView /></ErrorBoundary>)} />
<Route path="/diagrams/:repoId?" element={guard('diagrams', <ErrorBoundary><DiagramsView /></ErrorBoundary>)} />
```

Note: `/repos` has no guard (always visible). `/settings` has no guard (always visible). `/ba/:workItemId` maps to `'workitems'` feature key.

- [ ] **Step 4: Update SettingsView to receive onRoleChange**

Update the SettingsView route element to pass the callback:

```tsx
<Route
  path="/settings"
  element={
    <ErrorBoundary>
      <SettingsView onSettingsSaved={checkConnections} onRoleChange={handleRoleChange} userRole={userRole} />
    </ErrorBoundary>
  }
/>
```

- [ ] **Step 5: Verify the build compiles**

Run: `cd /Users/anthonyhumphreys/Code/innovation/exploration/devhub && npx electron-vite build 2>&1 | tail -20`
Expected: Build will have type errors for Shell and SettingsView props (expected — they're updated in the next tasks).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat(onboarding): wire up role state, onboarding gate, and route protection in App"
```

---

### Task 4: Update Shell to forward userRole

**Files:**
- Modify: `src/renderer/components/layout/Shell.tsx:1-28`

- [ ] **Step 1: Add userRole and onRoleChange to ShellProps**

Update the `ShellProps` interface and component signature:

```typescript
import type { UserRole } from '../../../shared/types';

interface ShellProps {
  connectionStatus: {
    foundry: boolean | null;
    ado: boolean | null;
    confluence: boolean | null;
  };
  userRole: UserRole;
  onRoleChange: (role: UserRole) => void;
}
```

Update the function signature:

```typescript
export function Shell({ connectionStatus, userRole, onRoleChange }: ShellProps) {
```

- [ ] **Step 2: Pass userRole to Sidebar**

Change the Sidebar invocation:

```tsx
<Sidebar connectionStatus={connectionStatus} userRole={userRole} />
```

- [ ] **Step 3: Verify the build compiles**

Run: `cd /Users/anthonyhumphreys/Code/innovation/exploration/devhub && npx electron-vite build 2>&1 | tail -20`
Expected: May still have type errors from Sidebar (updated next). Shell compiles.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/layout/Shell.tsx
git commit -m "feat(onboarding): forward userRole through Shell to Sidebar"
```

---

### Task 5: Update Sidebar to filter nav items by role

**Files:**
- Modify: `src/renderer/components/layout/Sidebar.tsx:1-114`

- [ ] **Step 1: Add feature key to NavItem and filter by role**

Import the types:

```typescript
import type { UserRole } from '../../../shared/types';
import { ROLE_FEATURES } from '../../../shared/types';
```

Update the `NavItem` interface to include a feature key:

```typescript
interface NavItem {
  path: string;
  label: string;
  icon: ReactNode;
  feature: string;
}
```

Add the `feature` key to each nav item in the array:

```typescript
const navItems: NavItem[] = [
  { path: '/repos', label: 'Repositories', icon: <Code size={20} />, feature: 'repos' },
  { path: '/chat', label: 'Chat', icon: <MessageSquare size={20} />, feature: 'chat' },
  { path: '/onboard', label: 'Onboarding', icon: <Compass size={20} />, feature: 'onboard' },
  { path: '/workitems', label: 'Work Items', icon: <TicketCheck size={20} />, feature: 'workitems' },
  { path: '/security', label: 'Security', icon: <Shield size={20} />, feature: 'security' },
  { path: '/codereview', label: 'Code Review', icon: <GitPullRequest size={20} />, feature: 'codereview' },
  { path: '/docs', label: 'Documentation', icon: <FileText size={20} />, feature: 'docs' },
  { path: '/diagrams', label: 'Diagrams', icon: <GitFork size={20} />, feature: 'diagrams' },
];
```

- [ ] **Step 2: Update SidebarProps and filter the list**

Update the `SidebarProps` interface:

```typescript
interface SidebarProps {
  connectionStatus: {
    foundry: boolean | null;
    ado: boolean | null;
    confluence: boolean | null;
  };
  userRole: UserRole;
}
```

Update the function signature:

```typescript
export function Sidebar({ connectionStatus, userRole }: SidebarProps) {
```

In the `<nav>` section, replace `{navItems.map(` with:

```tsx
{navItems
  .filter((item) => ROLE_FEATURES[userRole].includes(item.feature))
  .map((item) => {
```

(The rest of the `.map` callback stays the same.)

- [ ] **Step 3: Verify the build compiles**

Run: `cd /Users/anthonyhumphreys/Code/innovation/exploration/devhub && npx electron-vite build 2>&1 | tail -20`
Expected: Build succeeds (or only SettingsView prop errors remain).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/layout/Sidebar.tsx
git commit -m "feat(onboarding): filter sidebar nav items by user role"
```

---

### Task 6: Add role switcher to SettingsView

**Files:**
- Modify: `src/renderer/components/settings/SettingsView.tsx:1-422`

- [ ] **Step 1: Update SettingsViewProps**

Add the new props:

```typescript
import type { UserRole } from '../../../shared/types';

interface SettingsViewProps {
  onSettingsSaved?: () => void;
  onRoleChange?: (role: UserRole) => void;
  userRole?: UserRole;
}
```

Update the function signature:

```typescript
export function SettingsView({ onSettingsSaved, onRoleChange, userRole }: SettingsViewProps) {
```

- [ ] **Step 2: Add role switcher section**

After the settings page header (`<h2>Settings</h2>` block, around line 86) and before the LLM Provider section, add:

```tsx
{/* Role */}
<Section title="Role">
  <p className="text-sm text-text-secondary">
    Choose your role to control which features are visible in the sidebar.
  </p>
  <div className="flex gap-2">
    <ProviderButton
      label="Developer"
      description="Full access to all tools"
      active={userRole === 'developer'}
      onClick={async () => {
        await window.anvil.settings.update({ userRole: 'developer' });
        onRoleChange?.('developer');
      }}
    />
    <ProviderButton
      label="BA / BRM"
      description="Docs, diagrams, chat & work items"
      active={userRole === 'ba-brm'}
      onClick={async () => {
        await window.anvil.settings.update({ userRole: 'ba-brm' });
        onRoleChange?.('ba-brm');
      }}
    />
  </div>
</Section>
```

- [ ] **Step 3: Verify the full build compiles**

Run: `cd /Users/anthonyhumphreys/Code/innovation/exploration/devhub && npx electron-vite build 2>&1 | tail -20`
Expected: Build succeeds with zero type errors.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/settings/SettingsView.tsx
git commit -m "feat(onboarding): add role switcher to settings view"
```

---

### Task 7: Manual smoke test

- [ ] **Step 1: Start the app in dev mode**

Run: `cd /Users/anthonyhumphreys/Code/innovation/exploration/devhub && npx electron-vite dev`

- [ ] **Step 2: Verify onboarding overlay**

Expected: Full-screen overlay shows "What best describes your role?" with two stacked cards (Developer, BA/BRM).

- [ ] **Step 3: Select BA/BRM role**

Expected: Overlay dismisses. Sidebar shows only: Repositories, Chat, Work Items, Documentation, Diagrams, Settings.

- [ ] **Step 4: Try navigating to a hidden route**

Manually type `#/security` in the URL bar.
Expected: Redirects to `/repos`.

- [ ] **Step 5: Switch role in Settings**

Go to Settings → Role section → click Developer.
Expected: Sidebar immediately shows all nav items (Repositories, Chat, Onboarding, Work Items, Security, Code Review, Documentation, Diagrams).

- [ ] **Step 6: Restart the app**

Close and reopen the app.
Expected: No onboarding overlay — goes straight to the app with the previously selected role. Sidebar shows the correct items for the saved role.

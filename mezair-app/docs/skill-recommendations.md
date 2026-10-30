# Recommended skill collections

The Skills & MCPs manager opens on **Recommended**. Each entry is a creator’s
collection: install the entire set or explore and install individual skills.
Browsing never installs a skill. Installs add skills to the user's Codex library
through the existing `skills` CLI.

## Curating Mezair's catalogue in code

Edit `src/shared/config/skill-recommendations.ts`. It is a typed, ordered list of
explicitly trusted repositories. Theo's tstack, poteto's pstack and Matt Pocock's
skills are the initial collections. A collection can target a directory inside
a larger repository, so recommending pstack does not include other Cursor plugins.

```ts
{
  id: 'theo',
  name: "Theo's skills",
  description: 'Everyday engineering workflows.',
  repository: 't3dotgg/tstack',
  path: 'skills',
  // ref: 'v1.0.0',             // Optional branch, tag or commit.
  // skills: ['file-pr'],       // Optional exact names; omit for the whole set.
}
```

The catalogue ships with the app. Repository contents are discovered at runtime;
there is no separate list of skill names to keep current. `repository` accepts
`owner/repo` or an HTTPS GitHub repository URL. `path` restricts discovery and
installation. Source ids must be unique within a catalogue. A catalogue supports
20 collections, a repository collection supports 200 discovered skills, and an
optional explicit selection supports 100 skill names.

Discovery reads bounded GitHub API responses and YAML frontmatter. It never
executes repository content. Private repository access and API rate-limit fallback
use the user's existing `gh` authentication without extracting its credential.
Each install uses the discovered commit and explicit skill names, preserving the
chosen directory and avoiding changes from a branch moving during installation.
Some third-party workflows expect particular tools or agent capabilities; installing
their instructions does not supply those tools.

## Organisation recommendations

On a compatible Mezair Cloud backend, members see **Recommended by [organisation]**.
Organisation owners can open **Configure collections**, add repository collections,
and edit their names, descriptions, directories and optional refs. Valid changes
save on blur. Autosaves are serialized, so editing another field while a request
is in flight preserves the newer draft. Members decide which collections to install.

The same `SkillRecommendationSource` format is used in code and by the API. The
`skills.recommendations.set` RPC accepts `organizationId`, `expectedVersion` (zero
for a new catalogue), and `sources`; `skills.recommendations.list` returns the
current caller's organisations and catalogues. Updates use optimistic versions;
an old version returns `conflict` rather than overwriting another owner's change.
If an update conflicts, the editor retains the local draft. **Reload shared
collections** explicitly discards that draft and reloads the shared catalogue;
reopen configuration to review and edit the latest version.
All reads and writes require current active, synced membership. Only owners may
write. Ephemeral workers are denied. The desktop binds requests to its current
backend/account and rechecks organisation access before installation.

Deploy backend migration `0008_skill_recommendations.sql` with this backend version.
The discovery feature `organization-skill-recommendations/1` gates desktop org
requests. Older backends and signed-out users still have Mezair's built-in catalogue.
No org configuration, deployment or real skill installation is performed by the
synthetic preview.

## Verification

From `mezair-app/`:

```sh
pnpm exec vitest run src/main/services/__tests__/skill-recommendations.service.test.ts src/main/services/__tests__/codex-registry.service.test.ts
pnpm exec vite --config scripts/chat-replay.vite.config.ts
```

Open `http://127.0.0.1:4179/?skills` for the synthetic UI, including collection
inspection and owner configuration. Its install actions have no external effect.
Use `?skills&skills-conflict` to simulate another owner editing during autosave
and verify the reload recovery path.
From `cloud/backend/`, run `pnpm exec vitest run test/skill-recommendations.test.ts`.

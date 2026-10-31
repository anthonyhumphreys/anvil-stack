# Screenshot capture guide

Maintainer instructions for refreshing the website assets. This guide is kept
in the repository and is not part of the public documentation.

Every product image on mezair.dev is a screenshot of Mezair Desktop with sample data. The website draws none of them. The animations on the [Sync & Mesh page](/sync) are diagrams, and the page labels them that way.

## Sources

Captures come from two places, both in `mezair-app`:

| Source | What it renders | Used for |
| --- | --- | --- |
| **Desktop** | The Electron app on an isolated profile, with the development-only processing fixture at `/_dev/processing`. Real shell, preload and transcript components. | The finished run and its expanded steps. |
| **Replay harness** | The standalone Vite preview in `src/renderer/components/chat/replay/`. Production components with an in-memory bridge; no Electron, IPC, provider or backend. | Factories, workflows, Sync & Mesh settings, Mesh jobs, session ownership and inline review surfaces. |

The source code labels all fixture content as synthetic. The Acme workspace, its `storefront` repository, Dana's devices and every job, commit and finding are invented. No agent, provider, GitHub account or Sync backend is contacted while capturing.

`public/screens/manifest.json` records each image's source route, fixture, pixel size, app commit and capture date. The website reads its sizes from there, so images never shift the layout while loading.

## Refresh the captures

1. Start the replay harness from `mezair-app`:

   ```bash
   pnpm exec vite --config scripts/chat-replay.vite.config.ts
   ```

2. Start Desktop on a throwaway profile with remote debugging:

   ```bash
   MEZAIR_DEV_USER_DATA_PATH=/tmp/mezair-capture \
   MEZAIR_DEV_PROCESSING_PREVIEW=1 \
     pnpm dev -- --remote-debugging-port=9333
   ```

   If your shell sets `ELECTRON_RUN_AS_NODE`, unset it first. Finish the welcome flow with **Continue without Sync**, set the theme to Dark, and add a fixture workspace named Acme with a small local repository that has at least one commit.

   Website examples use `gpt-6.1-sol` with `xhigh` reasoning (shown as **Extra high** in the composer). Keep the processing, factory, Mesh and chat replay fixtures consistent when refreshing the captures.

3. Capture from `mezair-website`:

   ```bash
   node scripts/capture-screens.mjs            # everything
   node scripts/capture-screens.mjs mesh-jobs  # just one
   ```

The script uses Chrome through the DevTools protocol with no extra dependencies, writes 2× WebP files to `public/screens/` (PNG if `cwebp` is missing), and rewrites the manifest. Set `CHROME_PATH`, `MEZAIR_REPLAY_URL` or `MEZAIR_DESKTOP_CDP` if your setup differs. Development-only fixture controls are hidden during capture; nothing else is changed.

Refresh the matching JPEG copies in `app/_og/assets/` too: desktop, desktop steps and factories at 1400 px wide; Mesh jobs and review at 1100 px wide. Preserve their aspect ratio and update the social-card image dimensions if a capture's shape changes.

## Add a capture

Add an entry to the `captures` list in `scripts/capture-screens.mjs` with its source, route, viewport and, for panels, the element to clip. Then add its alt text and caption to `lib/screens.ts`. Write alt text that describes what the screen shows for someone who can't see it.

If a screen needs data no fixture provides, add it to a replay fixture in `mezair-app` rather than editing the image. The `?mesh` fixture in `MeshPreview.tsx` is a small example: it installs a typed in-memory bridge and renders the production settings components against it.

import manifest from "@/public/screens/manifest.json";

/**
 * Real Mezair Desktop captures. Every image is the production UI rendered with
 * synthetic fixture content (the Acme storefront workspace, example devices and
 * jobs). `scripts/capture-screens.mjs` writes the files and the manifest that
 * records each capture's source, fixture and app commit.
 */
export type ScreenId = keyof typeof manifest;

type ScreenText = {
  alt: string;
  /** Short, visible caption. */
  caption: string;
};

const text: Record<ScreenId, ScreenText> = {
  "desktop-run-complete": {
    alt: "Mezair Desktop in the Acme workspace. A Codex thread asked to raise the checkout retry limit to five. The run finished in six actions; the answer explains the change, notes that the fifth attempt waits 1.6 seconds, reports 14 passing tests and offers Review these changes for two edited files.",
    caption: "A finished run with the agent's answer and the two files it changed."
  },
  "desktop-run-steps": {
    alt: "The same Mezair thread with the work expanded: read src/lib/retry.ts, searched for withRetry, edited test/retry.test.ts, ran pnpm test -- retry with one failure, edited src/lib/retry.ts, then ran pnpm test with 14 passing.",
    caption: "Each step the agent took, including the failing test it wrote first."
  },
  "factories-line": {
    alt: "Mezair Factories view. A factory line takes labelled GitHub issues through stations from intake to merge; runs are shown at each station with live, waiting, needs approval and blocked states.",
    caption: "A software factory taking labelled GitHub issues through to merge."
  },
  "factories-workflows": {
    alt: "Mezair Workflows view showing reusable agent workflow templates, which factories pin, and the option to use a workflow in a factory.",
    caption: "Reusable agent workflows and the factories that use them."
  },
  "mesh-jobs": {
    alt: "Mesh jobs in Settings. A start-session job runs on studio-mac with its live attempt stream: checkout verified, pnpm install, a failing test, an edit and 14 passing tests, with a marked gap in the stream. Other jobs show Needs approval, Completed, Lost contact and Stopping.",
    caption: "Jobs on your other machines, with the output of the running job."
  },
  "mesh-approval": {
    alt: "A Mesh code-task job on build-box waiting for approval of a bootstrap recipe: pnpm install --frozen-lockfile and pnpm exec playwright install chromium, with Approve and Deny buttons and an expiry time.",
    caption: "A worker waiting for approval before it runs a bootstrap recipe."
  },
  "mesh-session": {
    alt: "Two session ownership strips. The first reads Session on this device with Move session open, listing studio-mac and build-box. The second reads Session on moving to studio-mac, source quiescing.",
    caption: "Moving a running session. During a handoff, the strip shows its current state."
  },
  "mesh-devices": {
    alt: "Enrolled devices in Settings, Sync and Mesh: Dana's MacBook Pro marked This device, studio-mac trusted by pairing, build-box trusted by manual approval, and old-imac revoked. Each has Rename, Compare and verify, and Revoke.",
    caption: "Each enrolled device, how it became trusted and a Revoke button."
  },
  "mesh-status": {
    alt: "Sync and Mesh status for this device: connected to the Acme Sync Cloudflare backend, Sync on with the live connection up, and this device allowed to run Mesh jobs.",
    caption: "The connected backend and whether this device runs Mesh jobs."
  },
  "surface-review": {
    alt: "An inline Review surface in a Mezair thread for a working tree: Blocked, with three risks and eight findings, the change explained in three chapters, and findings grouped by severity with Open actions.",
    caption: "A review that blocks on three risks and explains the change in sections."
  },
  "surface-findings": {
    alt: "A Findings surface from a security audit: one critical, one high, two medium and one low finding, each with a file and line, plus Ask agent to fix top 5.",
    caption: "Security findings with file and line numbers."
  },
  "surface-pipeline": {
    alt: "A Pipeline surface for CI: workflow, install, lint, test, build and deploy jobs as a graph, with the failing test job and an uncached install called out.",
    caption: "A CI pipeline drawn as a graph, with the slow and failing jobs marked."
  },
  "surface-dependencies": {
    alt: "A Dependencies surface: nine packages with three vulnerable, one restricted licence and two deprecated, plus Ask agent to upgrade 3 vulnerable.",
    caption: "Dependencies with their advisories, licences and deprecations."
  }
};

/** Settings panels captured on a transparent ground; they sit on the page without an extra frame. */
const panels = new Set<ScreenId>(["mesh-jobs", "mesh-approval", "mesh-session", "mesh-devices", "mesh-status"]);

export type Screen = ScreenText & (typeof manifest)[ScreenId] & { id: ScreenId; panel: boolean };

export function screen(id: ScreenId): Screen {
  return { id, ...manifest[id], ...text[id], panel: panels.has(id) };
}

export const screenProvenance =
  "These are screenshots of Mezair Desktop with sample data. No agent, provider or backend was contacted to make them.";

import type { Metadata } from "next";

import { AuthNotConfigured, BackendNotConfigured } from "@/components/account/not-configured";
import { BrowserWorkspaceClient } from "@/components/workspace/workspace-client";
import { hostedFailureMessage, loadAccountContext, tryHosted } from "@/lib/account";
import { listWorkspaceMachines } from "@/lib/hosted";

export const metadata: Metadata = {
  title: "Workspace | Anvil",
  robots: { index: false, follow: false },
};

/**
 * Account pages own their guard. The browser workspace gets the authenticated
 * account id only after WorkOS and the hosted service are available; it uses
 * that id to scope the persisted browser grant and workspace selection.
 */
export default async function AccountWorkspacePage() {
  const ctx = await loadAccountContext();
  if (ctx.status === "auth-unconfigured") return <AuthNotConfigured />;
  if (ctx.status === "backend-unconfigured") return <BackendNotConfigured />;
  const result = await tryHosted(() => listWorkspaceMachines(ctx.identity));
  const machines = result.ok
    ? result.data.map((machine) => ({
        enrollmentId: machine.enrollmentId,
        displayName: machine.name,
        ...(machine.meshHost ? { meshHost: machine.meshHost } : {}),
      }))
    : [];
  const discoveryDetail = result.ok
    ? undefined
    : result.code === "not-found"
      ? "This hosted service does not provide machine discovery yet. Pair and manage machines from the Devices page."
      : hostedFailureMessage(result.code, result.status);
  return <BrowserWorkspaceClient accountScope={ctx.user.id} machines={machines} discoveryDetail={discoveryDetail} />;
}

import type { Metadata } from "next";

import { AuthNotConfigured, BackendNotConfigured } from "@/components/account/not-configured";
import { BrowserWorkspaceClient } from "@/components/workspace/workspace-client";
import { loadAccountContext } from "@/lib/account";

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
  return <BrowserWorkspaceClient accountScope={ctx.user.id} />;
}

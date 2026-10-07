"use server";

import { revalidatePath } from "next/cache";

import { hostedIdentity } from "@/lib/auth";
import { hostedFailureMessage } from "@/lib/account";
import {
  createOrganization,
  createOrganizationPortal,
  HostedApiError,
  hostedConfigured,
  inviteOrganizationMember,
  leaveOrganization,
  listOrganizations,
  removeOrganizationMember,
  revokeOrganizationInvitation,
  updateOrganizationRole
} from "@/lib/hosted";
import { workosConfigured } from "@/lib/workos-env";
import type {
  HostedOrganizationCreateResult,
  HostedOrganizationInviteResult,
  HostedOrganizationListResult,
  HostedOrganizationRole,
  HostedPortalResult
} from "@/lib/hosted/types";
import type { ActionResult } from "@/app/account/actions";

async function identityOrNull() {
  if (!workosConfigured() || !hostedConfigured()) return null;
  return hostedIdentity();
}

function actionFailure(error: unknown): ActionResult<never> {
  if (error instanceof HostedApiError) {
    const reason = error.details?.["reason"];
    if (reason === "invitee-not-admitted" || reason === "user-not-admitted") {
      return {
        ok: false,
        message: "Only people with an admitted Anvil account can join this organisation."
      };
    }
    if (reason === "waitlist-approval-required") {
      return {
        ok: false,
        message: "This account needs WorkOS approval before it can join an organisation."
      };
    }
    if (reason === "last-owner") {
      return { ok: false, message: "Transfer ownership before removing the last organisation owner." };
    }
    if (reason === "no-team-seats") {
      return {
        ok: false,
        message:
          "This organisation has reached its limit of five allocated member seats. Ask the service operator whether a higher fair-use limit is available."
      };
    }
    if (reason === "invitation-already-exists-or-user-sponsored") {
      return { ok: false, message: "That account already has an invitation or is in this organisation." };
    }
    return { ok: false, message: hostedFailureMessage(error.code, error.status) };
  }
  return { ok: false, message: "Something went wrong. Try again." };
}

function requireOrgId(value: string): string | null {
  const id = value.trim();
  return id.length > 0 && id.length <= 255 && /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
}

function refreshOrganizationViews() {
  revalidatePath("/account/organizations");
  revalidatePath("/account/billing");
  revalidatePath("/account");
}

export async function listOrganizationsAction(): Promise<ActionResult<HostedOrganizationListResult>> {
  const identity = await identityOrNull();
  if (!identity) {
    return { ok: false, message: "The hosted account service is not configured on this deployment." };
  }
  try {
    return { ok: true, data: await listOrganizations(identity) };
  } catch (error) {
    return actionFailure(error);
  }
}

export async function createOrganizationAction(
  name: string
): Promise<ActionResult<HostedOrganizationCreateResult>> {
  const identity = await identityOrNull();
  if (!identity) {
    return { ok: false, message: "The hosted account service is not configured on this deployment." };
  }
  if (typeof name !== "string") {
    return { ok: false, message: "Enter an organisation name." };
  }
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 80) {
    return { ok: false, message: "Organisation names must be 2 to 80 characters." };
  }
  try {
    const data = await createOrganization(identity, trimmed, crypto.randomUUID().replaceAll("-", ""));
    refreshOrganizationViews();
    return { ok: true, data };
  } catch (error) {
    return actionFailure(error);
  }
}

export async function inviteOrganizationMemberAction(
  organizationId: string,
  email: string
): Promise<ActionResult<HostedOrganizationInviteResult>> {
  const identity = await identityOrNull();
  const orgId = requireOrgId(organizationId);
  const trimmedEmail = email.trim().toLowerCase();
  if (!identity) {
    return { ok: false, message: "The hosted account service is not configured on this deployment." };
  }
  if (!orgId) return { ok: false, message: "Unknown organisation." };
  if (trimmedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
    return { ok: false, message: "Enter a valid email address." };
  }
  try {
    const data = await inviteOrganizationMember(identity, orgId, trimmedEmail);
    refreshOrganizationViews();
    return { ok: true, data };
  } catch (error) {
    return actionFailure(error);
  }
}

export async function revokeOrganizationInvitationAction(
  organizationId: string,
  invitationId: string
): Promise<ActionResult<{ revoked: boolean }>> {
  const identity = await identityOrNull();
  const orgId = requireOrgId(organizationId);
  const inviteId = requireOrgId(invitationId);
  if (!identity) {
    return { ok: false, message: "The hosted account service is not configured on this deployment." };
  }
  if (!orgId || !inviteId) return { ok: false, message: "Unknown invitation." };
  try {
    const data = await revokeOrganizationInvitation(identity, orgId, inviteId);
    refreshOrganizationViews();
    return { ok: true, data };
  } catch (error) {
    return actionFailure(error);
  }
}

export async function removeOrganizationMemberAction(
  organizationId: string,
  workosUserId: string
): Promise<ActionResult<{ removed: boolean }>> {
  const identity = await identityOrNull();
  const orgId = requireOrgId(organizationId);
  const userId = requireOrgId(workosUserId);
  if (!identity) {
    return { ok: false, message: "The hosted account service is not configured on this deployment." };
  }
  if (!orgId || !userId) return { ok: false, message: "Unknown member." };
  try {
    const data = await removeOrganizationMember(identity, orgId, userId);
    refreshOrganizationViews();
    return { ok: true, data };
  } catch (error) {
    return actionFailure(error);
  }
}

export async function leaveOrganizationAction(
  organizationId: string
): Promise<ActionResult<{ left: boolean }>> {
  const identity = await identityOrNull();
  const orgId = requireOrgId(organizationId);
  if (!identity) {
    return { ok: false, message: "The hosted account service is not configured on this deployment." };
  }
  if (!orgId) return { ok: false, message: "Unknown organisation." };
  try {
    const data = await leaveOrganization(identity, orgId);
    refreshOrganizationViews();
    return { ok: true, data };
  } catch (error) {
    return actionFailure(error);
  }
}

export async function updateOrganizationRoleAction(
  organizationId: string,
  workosUserId: string,
  role: HostedOrganizationRole
): Promise<ActionResult<{ updated: boolean }>> {
  const identity = await identityOrNull();
  const orgId = requireOrgId(organizationId);
  const userId = requireOrgId(workosUserId);
  if (!identity) {
    return { ok: false, message: "The hosted account service is not configured on this deployment." };
  }
  if (!orgId || !userId || (role !== "owner" && role !== "member")) {
    return { ok: false, message: "Unknown organisation member or role." };
  }
  try {
    const data = await updateOrganizationRole(identity, orgId, userId, role);
    refreshOrganizationViews();
    return { ok: true, data };
  } catch (error) {
    return actionFailure(error);
  }
}

export async function createOrganizationPortalAction(
  organizationId: string
): Promise<ActionResult<HostedPortalResult>> {
  const identity = await identityOrNull();
  const orgId = requireOrgId(organizationId);
  if (!identity) {
    return { ok: false, message: "The hosted account service is not configured on this deployment." };
  }
  if (!orgId) return { ok: false, message: "Unknown organisation." };
  try {
    return { ok: true, data: await createOrganizationPortal(identity, orgId) };
  } catch (error) {
    return actionFailure(error);
  }
}

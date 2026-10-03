"use server";

import { revalidatePath } from "next/cache";

import { hostedIdentity } from "@/lib/auth";
import { hostedFailureMessage } from "@/lib/account";
import {
  closeOrganization,
  confirmOrganizationSeatIncrease,
  createOrganization,
  createOrganizationPortal,
  createTeamCheckout,
  HostedApiError,
  hostedConfigured,
  inviteOrganizationMember,
  leaveOrganization,
  listOrganizations,
  removeOrganizationMember,
  revokeOrganizationInvitation,
  quoteOrganizationSeatIncrease,
  updateOrganizationRole,
  updateOrganizationMemberSeat,
  updateOrganizationSeats
} from "@/lib/hosted";
import { workosConfigured } from "@/lib/workos-env";
import type {
  HostedBillingInterval,
  HostedOrganizationCloseResult,
  HostedOrganizationCreateResult,
  HostedOrganizationInviteResult,
  HostedOrganizationListResult,
  HostedOrganizationMemberSeatResult,
  HostedOrganizationRole,
  HostedOrganizationSeatChangeResult,
  HostedSeatIncreaseQuote,
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
    if (reason === "checkout-disabled") {
      return {
        ok: false,
        message: "Checkout is not enabled on this deployment. Production paid access begins 1 November 2026."
      };
    }
    if (reason === "invitee-not-admitted" || reason === "user-not-admitted") {
      return {
        ok: false,
        message:
          "Only people who already have an Anvil account can be invited. Ask them to join the waitlist and finish signup first."
      };
    }
    if (reason === "waitlist-approval-required") {
      return {
        ok: false,
        message:
          "Anvil hosted access is invite-only. The account must be approved through the WorkOS waitlist before using team billing."
      };
    }
    if (reason === "last-owner") {
      return { ok: false, message: "Transfer ownership before removing the last organisation owner." };
    }
    if (reason === "team-subscription-active") {
      return {
        ok: false,
        message: "Cancel the team plan and wait for its paid period to end before closing this organisation."
      };
    }
    if (reason === "team-checkout-open") {
      return {
        ok: false,
        message: "Finish or expire the open team checkout before closing this organisation."
      };
    }
    if (reason === "no-team-seats") {
      return {
        ok: false,
        message: "This organisation has no hosted seats available. Start a team plan or increase its seat capacity first."
      };
    }
    if (reason === "seat-reservation-unavailable") {
      return {
        ok: false,
        message: "Seat capacity changed before the update completed. Refresh the page and try again."
      };
    }
    if (reason === "invitation-already-exists-or-user-sponsored") {
      return {
        ok: false,
        message: "That person already has an invitation, is already a member, or has team-funded hosted access elsewhere."
      };
    }
    return { ok: false, message: hostedFailureMessage(error.code, error.status) };
  }
  return { ok: false, message: "Something went wrong. Try again." };
}

function requireOrgId(value: string): string | null {
  const id = value.trim();
  return id.length > 0 && id.length <= 255 && /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
}

function parseSeatQuote(value: unknown): HostedSeatIncreaseQuote | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const quote = value as Record<string, unknown>;
  if (
    typeof quote.quoteId !== "string" ||
    !/^[A-Za-z0-9_-]{8,256}$/.test(quote.quoteId) ||
    !Number.isSafeInteger(quote.seatCapacity) ||
    (quote.seatCapacity as number) < 5 ||
    (quote.seatCapacity as number) > 50 ||
    !Number.isSafeInteger(quote.requestedSeats) ||
    (quote.requestedSeats as number) < 5 ||
    (quote.requestedSeats as number) > 50 ||
    !Number.isSafeInteger(quote.amountDue) ||
    quote.currency !== "gbp" ||
    !Number.isSafeInteger(quote.taxAmount) ||
    (quote.taxAmount as number) < 0 ||
    !Number.isSafeInteger(quote.prorationDate) ||
    !Number.isSafeInteger(quote.expiresAt) ||
    (quote.expiresAt as number) <= Date.now()
  ) {
    return null;
  }
  return quote as unknown as HostedSeatIncreaseQuote;
}

export type ConfirmSeatIncreaseActionResult =
  | { ok: true; data: HostedOrganizationSeatChangeResult }
  | { ok: false; message: string; replacementQuote?: HostedSeatIncreaseQuote };

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

export async function closeOrganizationAction(
  organizationId: string
): Promise<ActionResult<HostedOrganizationCloseResult>> {
  const identity = await identityOrNull();
  const orgId = requireOrgId(organizationId);
  if (!identity) {
    return { ok: false, message: "The hosted account service is not configured on this deployment." };
  }
  if (!orgId) return { ok: false, message: "Unknown organisation." };
  try {
    const data = await closeOrganization(identity, orgId);
    refreshOrganizationViews();
    return { ok: true, data };
  } catch (error) {
    return actionFailure(error);
  }
}

export async function createOrganizationAction(
  name: string,
  ownerSeatAssigned: boolean
): Promise<ActionResult<HostedOrganizationCreateResult>> {
  const identity = await identityOrNull();
  if (!identity) {
    return { ok: false, message: "The hosted account service is not configured on this deployment." };
  }
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 80) {
    return { ok: false, message: "Organisation names must be 2 to 80 characters." };
  }
  if (typeof ownerSeatAssigned !== "boolean") {
    return { ok: false, message: "Choose whether the owner needs a team seat." };
  }
  try {
    const idempotencyKey = crypto.randomUUID().replaceAll("-", "");
    const data = await createOrganization(identity, trimmed, idempotencyKey, ownerSeatAssigned);
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

export async function updateOrganizationMemberSeatAction(
  organizationId: string,
  workosUserId: string,
  assigned: boolean
): Promise<ActionResult<HostedOrganizationMemberSeatResult>> {
  const identity = await identityOrNull();
  const orgId = requireOrgId(organizationId);
  const userId = requireOrgId(workosUserId);
  if (!identity) {
    return { ok: false, message: "The hosted account service is not configured on this deployment." };
  }
  if (!orgId || !userId || typeof assigned !== "boolean") {
    return { ok: false, message: "Unknown organisation member or seat state." };
  }
  try {
    const data = await updateOrganizationMemberSeat(identity, orgId, userId, assigned);
    refreshOrganizationViews();
    return { ok: true, data };
  } catch (error) {
    return actionFailure(error);
  }
}

export async function createTeamCheckoutAction(
  organizationId: string,
  interval: HostedBillingInterval,
  seats: number
): Promise<ActionResult<{ checkoutUrl: string }>> {
  const identity = await identityOrNull();
  const orgId = requireOrgId(organizationId);
  if (!identity) {
    return { ok: false, message: "The hosted account service is not configured on this deployment." };
  }
  if (!orgId || (interval !== "month" && interval !== "year")) {
    return { ok: false, message: "Choose a valid organisation and billing interval." };
  }
  if (!Number.isInteger(seats) || seats < 5 || seats > 50) {
    return { ok: false, message: "Team plans have a five-seat minimum and a 50-seat self-serve limit." };
  }
  try {
    const data = await createTeamCheckout(identity, orgId, interval, seats);
    return { ok: true, data: { checkoutUrl: data.checkoutUrl } };
  } catch (error) {
    return actionFailure(error);
  }
}

export async function updateOrganizationSeatsAction(
  organizationId: string,
  seats: number
): Promise<ActionResult<HostedOrganizationSeatChangeResult>> {
  const identity = await identityOrNull();
  const orgId = requireOrgId(organizationId);
  if (!identity) {
    return { ok: false, message: "The hosted account service is not configured on this deployment." };
  }
  if (!orgId || !Number.isInteger(seats) || seats < 5 || seats > 50) {
    return { ok: false, message: "Choose a capacity from five to 50 seats." };
  }
  try {
    const data = await updateOrganizationSeats(identity, orgId, seats);
    refreshOrganizationViews();
    return { ok: true, data };
  } catch (error) {
    return actionFailure(error);
  }
}

export async function quoteOrganizationSeatIncreaseAction(
  organizationId: string,
  seats: number
): Promise<ActionResult<HostedSeatIncreaseQuote>> {
  const identity = await identityOrNull();
  const orgId = requireOrgId(organizationId);
  if (!identity) {
    return { ok: false, message: "The hosted account service is not configured on this deployment." };
  }
  if (!orgId || !Number.isInteger(seats) || seats < 5 || seats > 50) {
    return { ok: false, message: "Choose a capacity from five to 50 seats." };
  }
  try {
    const quote = await quoteOrganizationSeatIncrease(identity, orgId, seats);
    const validQuote = parseSeatQuote(quote);
    return validQuote?.requestedSeats === seats
      ? { ok: true, data: validQuote }
      : { ok: false, message: "The billing preview was invalid or expired. Request a new preview." };
  } catch (error) {
    return actionFailure(error);
  }
}

export async function confirmOrganizationSeatIncreaseAction(
  organizationId: string,
  quoteId: string,
  requestedSeats: number
): Promise<ConfirmSeatIncreaseActionResult> {
  const identity = await identityOrNull();
  const orgId = requireOrgId(organizationId);
  if (!identity) {
    return { ok: false, message: "The hosted account service is not configured on this deployment." };
  }
  if (
    !orgId ||
    !/^[A-Za-z0-9_-]{8,256}$/.test(quoteId) ||
    !Number.isInteger(requestedSeats) ||
    requestedSeats < 5 ||
    requestedSeats > 50
  ) {
    return { ok: false, message: "The billing preview is invalid. Request a new preview." };
  }
  try {
    const data = await confirmOrganizationSeatIncrease(identity, orgId, quoteId);
    refreshOrganizationViews();
    return { ok: true, data };
  } catch (error) {
    if (error instanceof HostedApiError) {
      const reason = error.details?.["reason"];
      if (reason === "seat-quote-changed") {
        const parsedQuote = parseSeatQuote(error.details?.["quote"]);
        const replacementQuote =
          parsedQuote?.requestedSeats === requestedSeats ? parsedQuote : null;
        return {
          ok: false,
          message: replacementQuote
            ? "The price changed. Review the updated total and confirm again to continue."
            : "The price changed. Request a new preview before confirming.",
          ...(replacementQuote ? { replacementQuote } : {})
        };
      }
      if (reason === "seat-quote-expired" || reason === "seat-quote-invalid") {
        return { ok: false, message: "This billing preview expired or is no longer valid. Request a new preview." };
      }
    }
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

"use server";

import { workosConfigured } from "@/lib/workos-env";
import { revalidatePath } from "next/cache";
import { signOut } from "@/lib/workos-sdk";

import { hostedIdentity } from "@/lib/auth";
import { hostedFailureMessage } from "@/lib/account";
import {
  createPortal,
  createCheckout,
  redeemBetaCode,
  deleteAccount,
  getDataStatus,
  hostedConfigured,
  reconcile,
  renameDevice,
  revokeDevice,
  HostedApiError
} from "@/lib/hosted";
import type {
  HostedDataStatusResult,
  HostedBillingInterval,
  HostedCheckoutResult,
  HostedDeleteAccountResult,
  HostedReconcileResult
} from "@/lib/hosted/types";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string; code?: string };

const NOT_CONFIGURED: ActionResult<never> = {
  ok: false,
  message: "The hosted account service is not configured on this deployment."
};

function fail(error: unknown): ActionResult<never> {
  if (error instanceof HostedApiError) {
    const reason =
      error.details && typeof error.details["reason"] === "string"
        ? (error.details["reason"] as string)
        : null;
    if (reason === "waitlist-approval-required") {
      return {
        ok: false,
        message:
          "WorkOS account approval is required to use hosted Sync & Mesh. Request access through the waitlist and finish signup after approval."
      };
    }
    if (reason === "last-organization-owner") {
      return {
        ok: false,
        code: "last-organization-owner",
        message: "Transfer organisation ownership before deleting this hosted account."
      };
    }
    if (reason === "account-deleted") {
      return { ok: false, message: "This hosted account has been deleted." };
    }
    if (reason === "beta-code-invalid") {
      return { ok: false, message: "That beta code is invalid, expired, revoked, or already used by another account." };
    }
    if (reason === "sync-checkout-disabled") {
      return { ok: false, message: "Paid signup is not open yet. Join the waitlist or redeem your beta code." };
    }
    if (reason === "subscription-exists" || reason === "checkout-in-progress") {
      return { ok: false, message: "A subscription or checkout is already on file. Refresh billing or manage the existing subscription." };
    }
    return { ok: false, message: hostedFailureMessage(error.code, error.status) };
  }
  // Never leak internals to the client.
  return { ok: false, message: "Something went wrong. Try again." };
}

async function requireIdentity() {
  if (!workosConfigured() || !hostedConfigured()) return null;
  return hostedIdentity();
}

function revalidateAccount() {
  revalidatePath("/account", "layout");
}

const DISPLAY_NAME_MAX = 80;
export async function createCheckoutAction(
  interval: HostedBillingInterval,
  organizationId?: string,
  seats?: number
): Promise<ActionResult<HostedCheckoutResult>> {
  const identity = await requireIdentity();
  if (!identity) return NOT_CONFIGURED;
  if ((interval !== "month" && interval !== "year") ||
    (organizationId !== undefined && (!/^[A-Za-z0-9_-]{1,255}$/.test(organizationId) ||
      !Number.isSafeInteger(seats) || seats! < 5 || seats! > 50))) {
    return { ok: false, message: "Choose a billing interval and 5 to 50 team seats." };
  }
  try {
    return { ok: true, data: await createCheckout(identity, interval, organizationId, seats) };
  } catch (error) { return fail(error); }
}

export async function redeemBetaCodeAction(code: string): Promise<ActionResult<{ accessUntil: string }>> {
  const identity = await requireIdentity();
  if (!identity) return NOT_CONFIGURED;
  if (typeof code !== "string" || !/^anvil_beta_[a-f0-9]{32}$/i.test(code.trim())) {
    return { ok: false, message: "Enter the complete beta code from your invitation." };
  }
  try {
    const data = await redeemBetaCode(identity, code.trim());
    revalidateAccount();
    return { ok: true, data };
  } catch (error) { return fail(error); }
}
const ENROLLMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export async function renameDeviceAction(
  enrollmentId: string,
  displayName: string
): Promise<ActionResult<{ renamed: boolean; enrollmentId: string }>> {
  const identity = await requireIdentity();
  if (!identity) return NOT_CONFIGURED;
  if (!ENROLLMENT_ID_PATTERN.test(enrollmentId)) {
    return { ok: false, message: "Unknown device." };
  }
  if (displayName.length > DISPLAY_NAME_MAX) {
    return { ok: false, message: `Device names are limited to ${DISPLAY_NAME_MAX} characters.` };
  }
  try {
    const data = await renameDevice(identity, enrollmentId, displayName.trim());
    revalidateAccount();
    return { ok: true, data };
  } catch (error) {
    return fail(error);
  }
}

export async function revokeDeviceAction(
  enrollmentId: string
): Promise<ActionResult<{ revoked: boolean; enrollmentId: string }>> {
  const identity = await requireIdentity();
  if (!identity) return NOT_CONFIGURED;
  if (!ENROLLMENT_ID_PATTERN.test(enrollmentId)) {
    return { ok: false, message: "Unknown device." };
  }
  try {
    const data = await revokeDevice(identity, enrollmentId);
    revalidateAccount();
    return { ok: true, data };
  } catch (error) {
    return fail(error);
  }
}

export async function createPortalAction(): Promise<ActionResult<{ portalUrl: string }>> {
  const identity = await requireIdentity();
  if (!identity) return NOT_CONFIGURED;
  try {
    const data = await createPortal(identity);
    return { ok: true, data: { portalUrl: data.portalUrl } };
  } catch (error) {
    return fail(error);
  }
}

export async function reconcileAction(): Promise<ActionResult<HostedReconcileResult>> {
  const identity = await requireIdentity();
  if (!identity) return NOT_CONFIGURED;
  try {
    const data = await reconcile(identity);
    revalidateAccount();
    return { ok: true, data };
  } catch (error) {
    return fail(error);
  }
}

export async function dataStatusAction(): Promise<ActionResult<HostedDataStatusResult>> {
  const identity = await requireIdentity();
  if (!identity) return NOT_CONFIGURED;
  try {
    const data = await getDataStatus(identity);
    return { ok: true, data };
  } catch (error) {
    return fail(error);
  }
}

export async function deleteAccountAction(): Promise<ActionResult<HostedDeleteAccountResult>> {
  const identity = await requireIdentity();
  if (!identity) return NOT_CONFIGURED;
  try {
    const data = await deleteAccount(identity);
    revalidateAccount();
    return { ok: true, data };
  } catch (error) {
    return fail(error);
  }
}

/** Signs the WorkOS session out and redirects — never returns a result. */
export async function signOutAction(): Promise<void> {
  if (!workosConfigured()) return;
  await signOut({ returnTo: "/" });
}

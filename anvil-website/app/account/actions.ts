"use server";

import { revalidatePath } from "next/cache";
import { signOut } from "@workos-inc/authkit-nextjs";

import { hostedIdentity } from "@/lib/auth";
import { hostedFailureMessage } from "@/lib/account";
import {
  createCheckout,
  createLinkCode,
  createPortal,
  deleteAccount,
  getDataStatus,
  hostedConfigured,
  pairDevice,
  reconcile,
  renameDevice,
  revokeDevice,
  HostedApiError
} from "@/lib/hosted";
import type {
  HostedBillingInterval,
  HostedDataStatusResult,
  HostedDeleteAccountResult,
  HostedLinkCodeResult,
  HostedPairDeviceResult,
  HostedReconcileResult
} from "@/lib/hosted/types";
import { workosConfigured } from "@/lib/workos-env";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string };

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
    if (reason === "checkout-disabled") {
      return {
        ok: false,
        message: "Checkout is not enabled yet — paid plans start 1 Nov 2026."
      };
    }
    if (reason === "account-deleted") {
      return { ok: false, message: "This hosted account has been deleted." };
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
const ENROLLMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export async function pairDeviceAction(
  displayName: string | undefined
): Promise<ActionResult<HostedPairDeviceResult>> {
  const identity = await requireIdentity();
  if (!identity) return NOT_CONFIGURED;
  const trimmed = displayName?.trim();
  if (trimmed !== undefined && trimmed.length > DISPLAY_NAME_MAX) {
    return { ok: false, message: `Device names are limited to ${DISPLAY_NAME_MAX} characters.` };
  }
  try {
    const data = await pairDevice(identity, trimmed === "" ? undefined : trimmed);
    revalidateAccount();
    return { ok: true, data };
  } catch (error) {
    return fail(error);
  }
}

export async function createLinkCodeAction(): Promise<ActionResult<HostedLinkCodeResult>> {
  const identity = await requireIdentity();
  if (!identity) return NOT_CONFIGURED;
  try {
    const data = await createLinkCode(identity);
    return { ok: true, data };
  } catch (error) {
    return fail(error);
  }
}

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

export async function createCheckoutAction(
  interval: HostedBillingInterval
): Promise<ActionResult<{ checkoutUrl: string }>> {
  const identity = await requireIdentity();
  if (!identity) return NOT_CONFIGURED;
  if (interval !== "month" && interval !== "year") {
    return { ok: false, message: "Unknown billing interval." };
  }
  try {
    const data = await createCheckout(identity, interval);
    return { ok: true, data: { checkoutUrl: data.checkoutUrl } };
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

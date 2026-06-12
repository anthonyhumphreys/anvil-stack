"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { overrideCreateRequestSchema, overrideRevokeRequestSchema, resolveOverrideExpiry } from "@anvilstack/shared";
import { requestLlmReview } from "@/lib/admin-api";
import { uploadPopularPackageIndex } from "@/lib/admin-api";
import { adminCookieName, requireAdminSession } from "@/lib/auth";
import { config, getPersistence } from "@/lib/admin-data";

export async function loginAction(formData: FormData) {
  const token = String(formData.get("token") ?? "");
  if (!config.ADMIN_TOKEN || token !== config.ADMIN_TOKEN) {
    redirect("/?auth=invalid");
  }

  (await cookies()).set(adminCookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/"
  });
  redirect("/");
}

export async function logoutAction() {
  (await cookies()).delete(adminCookieName);
  redirect("/");
}

export async function createOverrideAction(formData: FormData) {
  if (!(await requireAdminSession())) redirect("/?auth=required");
  const body = {
    packageName: String(formData.get("packageName") ?? ""),
    version: optionalString(formData.get("version")),
    action: String(formData.get("action") ?? "allow"),
    reason: String(formData.get("reason") ?? ""),
    approvedBy: optionalString(formData.get("approvedBy")) ?? "admin-ui",
    expiresAt: optionalString(formData.get("expiresAt"))
  };
  const parsed = overrideCreateRequestSchema.safeParse(body);
  if (!parsed.success) redirect("/?override=invalid");

  const expiresAt = resolveOverrideExpiry(parsed.data.expiresAt, config.policy.overrides.defaultExpiryDays);
  if (expiresAt === null) redirect("/?override=invalid-expiry");

  const persistence = getPersistence();
  const override = { ...parsed.data, expiresAt };
  await persistence.putOverride(override);
  if (override.version) await persistence.deletePolicyDecision(override.packageName, override.version, config.policy.version);
  else await persistence.deletePolicyDecisionsForPackage(override.packageName, config.policy.version);
  await persistence.putAuditEvent({
    actor: override.approvedBy ?? "admin-ui",
    eventType: "override.created",
    targetType: "package",
    targetId: `${override.packageName}${override.version ? `@${override.version}` : ""}`,
    metadata: { source: "admin", action: override.action, reason: override.reason, expiresAt: override.expiresAt }
  });

  revalidatePath("/");
  if (override.version) revalidatePath(`/packages/${encodeURIComponent(override.packageName)}/${encodeURIComponent(override.version)}`);
}

export async function revokeOverrideAction(formData: FormData) {
  if (!(await requireAdminSession())) redirect("/?auth=required");
  const body = {
    packageName: String(formData.get("packageName") ?? ""),
    version: optionalString(formData.get("version")),
    revokedBy: optionalString(formData.get("revokedBy")) ?? "admin-ui"
  };
  const parsed = overrideRevokeRequestSchema.safeParse(body);
  if (!parsed.success) redirect("/?revoke=invalid");

  const persistence = getPersistence();
  const revoked = await persistence.revokeOverride(parsed.data.packageName, parsed.data.version, parsed.data.revokedBy);
  if (!revoked) redirect("/?revoke=missing");

  if (revoked.override.version) await persistence.deletePolicyDecision(revoked.override.packageName, revoked.override.version, config.policy.version);
  else await persistence.deletePolicyDecisionsForPackage(revoked.override.packageName, config.policy.version);
  await persistence.putAuditEvent({
    actor: parsed.data.revokedBy ?? "admin-ui",
    eventType: "override.revoked",
    targetType: "package",
    targetId: `${revoked.override.packageName}${revoked.override.version ? `@${revoked.override.version}` : ""}`,
    metadata: { source: "admin", action: revoked.override.action, reason: revoked.override.reason }
  });

  revalidatePath("/");
  if (revoked.override.version) revalidatePath(`/packages/${encodeURIComponent(revoked.override.packageName)}/${encodeURIComponent(revoked.override.version)}`);
}

export async function requestLlmReviewAction(formData: FormData) {
  if (!(await requireAdminSession())) redirect("/?auth=required");
  const packageName = String(formData.get("packageName") ?? "");
  const version = String(formData.get("version") ?? "");
  if (!packageName || !version) redirect("/");

  const response = await requestLlmReview(packageName, version, {
    requestedBy: optionalString(formData.get("requestedBy")) ?? "admin-ui",
    priority: optionalString(formData.get("priority")) ?? "high"
  });
  if (!response.ok) redirect(`/packages/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}?llm=failed`);
  redirect(`/packages/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}?llm=queued`);
}

export async function uploadPopularPackageIndexAction(formData: FormData) {
  if (!(await requireAdminSession())) redirect("/?auth=required");
  const rawIndex = String(formData.get("indexJson") ?? "");
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawIndex) as Record<string, unknown>;
  } catch {
    redirect("/popular-package-index?upload=invalid-json");
  }
  const generatedAt = optionalString(formData.get("generatedAt"));
  const uploadedBy = optionalString(formData.get("uploadedBy"));
  const response = await uploadPopularPackageIndex({ ...body, ...(generatedAt ? { generatedAt } : {}), ...(uploadedBy ? { uploadedBy } : {}) });
  if (!response.ok) redirect("/popular-package-index?upload=invalid");
  revalidatePath("/popular-package-index");
  redirect("/popular-package-index?upload=ok");
}

function optionalString(value: FormDataEntryValue | null) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : undefined;
}

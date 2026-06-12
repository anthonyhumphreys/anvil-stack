import "server-only";

import { cookies } from "next/headers";
import { config } from "@/lib/admin-data";

export const adminCookieName = "anvil_admin_token";

export async function isAdminSession() {
  if (!config.ADMIN_TOKEN) return true;
  return (await cookies()).get(adminCookieName)?.value === config.ADMIN_TOKEN;
}

export async function requireAdminSession() {
  return isAdminSession();
}

export function isAdminTokenValue(value: string | undefined) {
  return Boolean(!config.ADMIN_TOKEN || value === config.ADMIN_TOKEN);
}

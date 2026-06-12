import type { AuthRequirement } from "./app.js";
import { RuntimeError } from "./errors.js";
import type { AuthIdentity } from "./host.js";

export type AuthPolicyInspection = {
  access: "public" | "optional" | "required";
  roles?: string[];
};

export function normaliseAuthRequirement(
  requirement: "none" | AuthRequirement | undefined,
  fallback: "public" | "optional" | "required",
): AuthPolicyInspection {
  if (requirement === undefined) {
    return { access: fallback };
  }

  if (requirement === "none" || requirement === "public") {
    return { access: "public" };
  }

  if (requirement === "optional") {
    return { access: "optional" };
  }

  if (requirement === "required") {
    return { access: "required" };
  }

  return { access: "required", roles: requirement.roles };
}

export function enforceAuthRequirement(
  policy: AuthPolicyInspection,
  identity: AuthIdentity | null,
): void {
  if (policy.access === "public" || policy.access === "optional") {
    return;
  }

  if (!identity) {
    throw new RuntimeError(
      "AUTH_REQUIRED",
      "A signed-in user is required.",
      401,
    );
  }

  if (policy.roles && policy.roles.length > 0) {
    const roles = identity.roles ?? [];
    const matched = policy.roles.some((role) => roles.includes(role));

    if (!matched) {
      throw new RuntimeError(
        "FORBIDDEN",
        `One of the roles [${policy.roles.join(", ")}] is required.`,
        403,
      );
    }
  }
}

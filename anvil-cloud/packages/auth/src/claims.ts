import type { AuthIdentity } from "@anvil-cloud/runtime";
import type { ClaimsMapping } from "./types.js";

const defaultRoleClaims = ["roles", "cognito:groups", "groups"];

export function identityFromClaims(
  claims: Record<string, unknown>,
  mapping: ClaimsMapping = {},
): AuthIdentity {
  const userIdClaim = mapping.userId ?? "sub";
  const emailClaim = mapping.email ?? "email";
  const roleClaims =
    mapping.roles === undefined
      ? defaultRoleClaims
      : Array.isArray(mapping.roles)
        ? mapping.roles
        : [mapping.roles];

  const userId = stringClaim(claims, userIdClaim);

  if (!userId) {
    throw new Error(`Token is missing the '${userIdClaim}' claim.`);
  }

  const identity: AuthIdentity = { userId, claims };
  const email = stringClaim(claims, emailClaim);

  if (email) {
    identity.email = email;
  }

  for (const roleClaim of roleClaims) {
    const roles = rolesClaim(claims, roleClaim);

    if (roles) {
      identity.roles = roles;
      break;
    }
  }

  return identity;
}

function stringClaim(
  claims: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = claims[name];

  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function rolesClaim(
  claims: Record<string, unknown>,
  name: string,
): string[] | undefined {
  const value = claims[name];

  if (Array.isArray(value)) {
    const roles = value.filter(
      (entry): entry is string => typeof entry === "string",
    );

    return roles.length > 0 ? roles : undefined;
  }

  if (typeof value === "string" && value.length > 0) {
    return value.split(/[\s,]+/).filter((entry) => entry.length > 0);
  }

  return undefined;
}

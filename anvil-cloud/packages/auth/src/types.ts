import type { AuthIdentity } from "@anvil-cloud/runtime";

export type VerifiedToken = {
  identity: AuthIdentity;
  issuer: string;
  subject: string;
  expiresAt: string;
  claims: Record<string, unknown>;
};

export interface TokenVerifier {
  readonly issuer: string;
  verifyToken(token: string): Promise<VerifiedToken>;
}

export type ClaimsMapping = {
  userId?: string;
  email?: string;
  roles?: string | string[];
};

export type AuthErrorCode =
  | "TOKEN_INVALID"
  | "TOKEN_EXPIRED"
  | "ISSUER_MISMATCH"
  | "AUDIENCE_MISMATCH"
  | "DISCOVERY_FAILED"
  | "USER_NOT_FOUND"
  | "USER_EXISTS";

export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

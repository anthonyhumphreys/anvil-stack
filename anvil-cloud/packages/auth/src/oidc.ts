import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTVerifyOptions,
} from "jose";
import { identityFromClaims } from "./claims.js";
import {
  AuthError,
  type ClaimsMapping,
  type TokenVerifier,
  type VerifiedToken,
} from "./types.js";

export type OidcVerifierOptions = {
  issuer: string;
  audience?: string | string[];
  jwksUri?: string;
  claims?: ClaimsMapping;
};

export class OidcTokenVerifier implements TokenVerifier {
  readonly issuer: string;

  private readonly options: OidcVerifierOptions;
  private keySet: JWTVerifyGetKey | undefined;

  constructor(options: OidcVerifierOptions) {
    this.issuer = options.issuer;
    this.options = options;
  }

  async verifyToken(token: string): Promise<VerifiedToken> {
    const keySet = await this.resolveKeySet();

    const verifyOptions: JWTVerifyOptions = { issuer: this.issuer };

    if (this.options.audience !== undefined) {
      verifyOptions.audience = this.options.audience;
    }

    try {
      const { payload } = await jwtVerify(token, keySet, verifyOptions);
      const claims = payload as Record<string, unknown>;
      const identity = identityFromClaims(claims, this.options.claims);

      return {
        identity,
        issuer: this.issuer,
        subject: identity.userId,
        expiresAt: payload.exp
          ? new Date(payload.exp * 1000).toISOString()
          : new Date(0).toISOString(),
        claims,
      };
    } catch (error) {
      throw toAuthError(error);
    }
  }

  private async resolveKeySet(): Promise<JWTVerifyGetKey> {
    if (this.keySet) {
      return this.keySet;
    }

    const jwksUri = this.options.jwksUri ?? (await this.discoverJwksUri());

    this.keySet = createRemoteJWKSet(new URL(jwksUri));

    return this.keySet;
  }

  private async discoverJwksUri(): Promise<string> {
    const discoveryUrl = new URL(
      ".well-known/openid-configuration",
      this.issuer.endsWith("/") ? this.issuer : `${this.issuer}/`,
    );

    let response: Response;

    try {
      response = await fetch(discoveryUrl);
    } catch (error) {
      throw new AuthError(
        "DISCOVERY_FAILED",
        `OIDC discovery request to ${discoveryUrl.href} failed: ${String(error)}`,
      );
    }

    if (!response.ok) {
      throw new AuthError(
        "DISCOVERY_FAILED",
        `OIDC discovery at ${discoveryUrl.href} returned ${response.status}.`,
      );
    }

    const document = (await response.json()) as { jwks_uri?: unknown };

    if (typeof document.jwks_uri !== "string") {
      throw new AuthError(
        "DISCOVERY_FAILED",
        `OIDC discovery document at ${discoveryUrl.href} has no jwks_uri.`,
      );
    }

    return document.jwks_uri;
  }
}

export function toAuthError(error: unknown): AuthError {
  if (error instanceof AuthError) {
    return error;
  }

  if (error instanceof joseErrors.JWTExpired) {
    return new AuthError("TOKEN_EXPIRED", "Token has expired.");
  }

  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    if (error.claim === "iss") {
      return new AuthError("ISSUER_MISMATCH", error.message);
    }

    if (error.claim === "aud") {
      return new AuthError("AUDIENCE_MISMATCH", error.message);
    }

    return new AuthError("TOKEN_INVALID", error.message);
  }

  return new AuthError(
    "TOKEN_INVALID",
    error instanceof Error ? error.message : "Token verification failed.",
  );
}

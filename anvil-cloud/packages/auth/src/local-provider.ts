import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuthIdentity } from "@anvil-cloud/runtime";
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  type JWK,
} from "jose";
import { identityFromClaims } from "./claims.js";
import { toAuthError } from "./oidc.js";
import { AuthError, type TokenVerifier, type VerifiedToken } from "./types.js";

export const localIssuer = "https://local.anvil.invalid/auth";

const signingAlgorithm = "ES256";

export type LocalUser = {
  userId: string;
  email?: string;
  roles?: string[];
  claims?: Record<string, unknown>;
};

export type LocalIdentityProviderOptions = {
  stateDir: string;
  issuer?: string;
  audience?: string;
};

export type IssueTokenOptions = {
  ttlSeconds?: number;
};

type KeyState = {
  privateJwk: JWK;
  publicJwk: JWK;
};

type UserState = {
  users: LocalUser[];
};

export class LocalIdentityProvider implements TokenVerifier {
  readonly issuer: string;

  private readonly stateDir: string;
  private readonly audience: string | undefined;
  private keys: KeyState | undefined;

  constructor(options: LocalIdentityProviderOptions) {
    this.stateDir = options.stateDir;
    this.issuer = options.issuer ?? localIssuer;
    this.audience = options.audience;
  }

  async listUsers(): Promise<LocalUser[]> {
    const state = await this.readUsers();

    return state.users;
  }

  async getUser(userId: string): Promise<LocalUser | null> {
    const state = await this.readUsers();

    return state.users.find((user) => user.userId === userId) ?? null;
  }

  async createUser(user: LocalUser): Promise<LocalUser> {
    const state = await this.readUsers();

    if (state.users.some((existing) => existing.userId === user.userId)) {
      throw new AuthError(
        "USER_EXISTS",
        `User '${user.userId}' already exists.`,
      );
    }

    const created: LocalUser = {
      userId: user.userId,
      email: user.email ?? `${user.userId}@local.anvil`,
      roles: user.roles ?? [],
      claims: user.claims ?? {},
    };

    state.users.push(created);
    await this.writeUsers(state);

    return created;
  }

  async deleteUser(userId: string): Promise<boolean> {
    const state = await this.readUsers();
    const remaining = state.users.filter((user) => user.userId !== userId);

    if (remaining.length === state.users.length) {
      return false;
    }

    await this.writeUsers({ users: remaining });

    return true;
  }

  async issueToken(
    userId: string,
    options: IssueTokenOptions = {},
  ): Promise<{ token: string; expiresAt: string; identity: AuthIdentity }> {
    const user = await this.getUser(userId);

    if (!user) {
      throw new AuthError("USER_NOT_FOUND", `User '${userId}' is not known.`);
    }

    const keys = await this.resolveKeys();
    const privateKey = await importJWK(keys.privateJwk, signingAlgorithm);
    const ttlSeconds = options.ttlSeconds ?? 60 * 60;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    const header: { alg: string; kid?: string } = { alg: signingAlgorithm };

    if (keys.publicJwk.kid !== undefined) {
      header.kid = keys.publicJwk.kid;
    }

    let builder = new SignJWT({
      ...user.claims,
      email: user.email,
      roles: user.roles,
    })
      .setProtectedHeader(header)
      .setIssuer(this.issuer)
      .setSubject(user.userId)
      .setIssuedAt()
      .setExpirationTime(expiresAt);

    if (this.audience) {
      builder = builder.setAudience(this.audience);
    }

    const token = await builder.sign(privateKey);
    const identity: AuthIdentity = { userId: user.userId };

    if (user.email !== undefined) {
      identity.email = user.email;
    }

    if (user.roles !== undefined) {
      identity.roles = user.roles;
    }

    if (user.claims !== undefined) {
      identity.claims = user.claims;
    }

    return { token, expiresAt: expiresAt.toISOString(), identity };
  }

  async verifyToken(token: string): Promise<VerifiedToken> {
    const keys = await this.resolveKeys();
    const publicKey = await importJWK(keys.publicJwk, signingAlgorithm);

    const verifyOptions: { issuer: string; audience?: string } = {
      issuer: this.issuer,
    };

    if (this.audience !== undefined) {
      verifyOptions.audience = this.audience;
    }

    try {
      const { payload } = await jwtVerify(token, publicKey, verifyOptions);
      const claims = payload as Record<string, unknown>;
      const identity = identityFromClaims(claims);

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

  async publicJwks(): Promise<{ keys: JWK[] }> {
    const keys = await this.resolveKeys();

    return { keys: [keys.publicJwk] };
  }

  private async resolveKeys(): Promise<KeyState> {
    if (this.keys) {
      return this.keys;
    }

    const keyPath = path.join(this.stateDir, "keys.json");

    try {
      const raw = await readFile(keyPath, "utf8");

      this.keys = JSON.parse(raw) as KeyState;

      return this.keys;
    } catch {
      // No keys yet; generate below.
    }

    const pair = await generateKeyPair(signingAlgorithm, {
      extractable: true,
    });
    const privateJwk = await exportJWK(pair.privateKey);
    const publicJwk = await exportJWK(pair.publicKey);
    const kid = `anvil-local-${Date.now().toString(36)}`;

    privateJwk.kid = kid;
    privateJwk.alg = signingAlgorithm;
    publicJwk.kid = kid;
    publicJwk.alg = signingAlgorithm;

    this.keys = { privateJwk, publicJwk };

    await mkdir(this.stateDir, { recursive: true });
    await writeFile(keyPath, `${JSON.stringify(this.keys, null, 2)}\n`, "utf8");

    return this.keys;
  }

  private async readUsers(): Promise<UserState> {
    try {
      const raw = await readFile(
        path.join(this.stateDir, "users.json"),
        "utf8",
      );

      return JSON.parse(raw) as UserState;
    } catch {
      return { users: [] };
    }
  }

  private async writeUsers(state: UserState): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    await writeFile(
      path.join(this.stateDir, "users.json"),
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8",
    );
  }
}

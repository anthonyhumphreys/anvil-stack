import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  browserWorkspaceCommandAssociatedData,
  browserWorkspaceResultAssociatedData,
  type BrowserWorkspaceCommandEnvelope,
  type BrowserWorkspaceOperation,
  type BrowserWorkspaceResultEnvelope,
} from '../../../../cloud/contract/browser-workspace';
import {
  dashboardGrantAssociatedData,
  dashboardSnapshotAssociatedData,
} from '../../../../cloud/contract/sealed';
import { SCHEMA_SQL } from '../../db/schema';

// Runtime-only sibling-project import: keep the website implementation in
// the acceptance test without pulling it into the app node tsconfig rootDir.
const WEBSITE_CRYPTO_MODULE = pathToFileURL(
  path.resolve(process.cwd(), '../anvil-website/lib/mesh-crypto.ts'),
).href;
type WebsiteWorkspaceInput = Omit<BrowserWorkspaceCommandEnvelope, 'v' | 'enc' | 'nonce' | 'ct'>;
type WebsiteGrantInner = {
  v: 1;
  dsk: string;
  scopes: string[];
  expiresAt: string;
  workspace?: { workspaceId: string; repoIds: string[] };
  enrollmentId?: string;
};
type WebsiteGrantEnvelope = {
  v: 1;
  enc: 'x25519-aes-256-gcm';
  requestId: string;
  browserPub: string;
  expiresAt: string;
  ephPub: string;
  nonce: string;
  ct: string;
};
type WebsiteCrypto = {
  generateBrowserKeypair: () => { priv: Uint8Array; pub: Uint8Array };
  encodeBrowserPub: (pub: Uint8Array) => string;
  decodeDsk: (inner: WebsiteGrantInner) => Uint8Array;
  decodeBase64: (value: string) => Uint8Array;
  encodeBase64: (value: Uint8Array) => string;
  grantAssociatedData: (input: {
    backendId: string;
    accountId: string;
    requestId: string;
    browserPub: string;
    expiresAt: string;
  }) => string;
  sealBrowserWorkspaceCommand: (
    dsk: Uint8Array,
    input: WebsiteWorkspaceInput & { payload: unknown },
  ) => Promise<BrowserWorkspaceCommandEnvelope>;
  openBrowserWorkspaceCommand: (
    dsk: Uint8Array,
    envelope: BrowserWorkspaceCommandEnvelope,
    input: WebsiteWorkspaceInput,
  ) => Promise<unknown>;
  sealBrowserWorkspaceResult: (
    dsk: Uint8Array,
    input: WebsiteWorkspaceInput & { result: unknown },
  ) => Promise<BrowserWorkspaceResultEnvelope>;
  openBrowserWorkspaceResult: (
    dsk: Uint8Array,
    envelope: BrowserWorkspaceResultEnvelope,
    input: WebsiteWorkspaceInput,
  ) => Promise<unknown>;
  unwrapDashboardGrant: (
    priv: Uint8Array,
    browserPub: Uint8Array,
    grant: WebsiteGrantEnvelope,
    aadParts: { backendId: string; accountId: string },
  ) => Promise<WebsiteGrantInner | null>;
  openDashboardSnapshot: (
    dsk: Uint8Array,
    snapshot: { enc: 'aes-256-gcm'; seq: number; nonce: string; ct: string },
    aadParts: { backendId: string; accountId: string; requestId: string },
  ) => Promise<Record<string, unknown> | null>;
};

async function websiteCrypto(): Promise<WebsiteCrypto> {
  return (await import(/* @vite-ignore */ WEBSITE_CRYPTO_MODULE)) as unknown as WebsiteCrypto;
}

// Keep the app crypto module importable without starting Electron or a real
// SQLite profile. The acceptance assertions below only use its pure envelope
// helpers, but the service has those runtime dependencies at module scope.
const db = new Database(':memory:');
db.exec(SCHEMA_SQL);
vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (encrypted: Buffer) => encrypted.toString('utf8').slice('enc:'.length),
  },
}));
vi.mock('../persona.service.js', () => ({
  getPersonaById: (id: string) => (id === 'coder' ? { id } : null),
  buildSystemPrompt: () => '',
}));
const applyRemoteEntityPayload = vi.hoisted(() => vi.fn());
const readEntityPayloadJson = vi.hoisted(() => vi.fn(() => null));
const entityPayloadIssue = vi.hoisted(() => vi.fn(() => null));
const isSupportedEntityType = vi.hoisted(() => vi.fn(() => true));
vi.mock('../sync-entity-domain.js', () => ({
  applyRemoteEntityPayload,
  entityPayloadIssue,
  isSupportedEntityType,
  readEntityPayloadJson,
}));

import { sealJsonEnvelope, sealToRecipientPub, unsealJsonEnvelope } from '../sync-keyring.service';

const DSK = Buffer.alloc(32, 0x42);
const base = {
  backendId: 'backend-crypto',
  accountId: 'account-crypto',
  requestId: 'dashboard-request-crypto',
  commandId: 'command-crypto',
  operation: 'chat.send' as BrowserWorkspaceOperation,
  workspaceId: 'workspace-crypto',
  repositoryId: 'repository-crypto',
  expiresAt: '2099-01-01T00:00:00.000Z',
};

function nodeCommandEnvelope(
  input: typeof base,
  payload: unknown,
): BrowserWorkspaceCommandEnvelope {
  return {
    v: 1,
    enc: 'aes-256-gcm',
    ...input,
    ...sealJsonEnvelope(DSK, browserWorkspaceCommandAssociatedData(input), payload),
  };
}

function nodeResultEnvelope(input: typeof base, result: unknown): BrowserWorkspaceResultEnvelope {
  return {
    v: 1,
    enc: 'aes-256-gcm',
    ...input,
    ...sealJsonEnvelope(DSK, browserWorkspaceResultAssociatedData(input), result),
  };
}

describe('browser workspace crypto acceptance', () => {
  it('round-trips browser commands and Desktop results through Node AES-GCM', async () => {
    const website = await websiteCrypto();
    const command = {
      message: 'hello from the hosted browser',
      sessionId: 'session-1',
      threadId: 'thread-1',
    };
    const browserCommand = await website.sealBrowserWorkspaceCommand(DSK, {
      ...base,
      payload: command,
    });

    // Browser WebCrypto -> the actual Desktop-side Node opener.
    expect(
      unsealJsonEnvelope(DSK, browserWorkspaceCommandAssociatedData(base), browserCommand),
    ).toEqual(command);

    // Desktop-side Node -> browser WebCrypto.
    expect(
      await website.openBrowserWorkspaceCommand(DSK, nodeCommandEnvelope(base, command), base),
    ).toEqual(command);

    const result = {
      commandId: base.commandId,
      data: { accepted: true, revision: 'rev-1' },
      ok: true,
    };
    const browserResult = await website.sealBrowserWorkspaceResult(DSK, { ...base, result });

    // Browser WebCrypto -> the actual Desktop-side Node opener.
    expect(
      unsealJsonEnvelope(DSK, browserWorkspaceResultAssociatedData(base), browserResult),
    ).toEqual(result);

    // Desktop-side Node -> browser WebCrypto.
    expect(
      await website.openBrowserWorkspaceResult(DSK, nodeResultEnvelope(base, result), base),
    ).toEqual(result);
  });

  it('authenticates every command/result AAD field and rejects reflection', async () => {
    const website = await websiteCrypto();
    const command = { message: 'AAD-bound command', sessionId: 'session-1', threadId: 'thread-1' };
    const result = { commandId: base.commandId, data: { ok: true }, ok: true };
    const browserCommand = await website.sealBrowserWorkspaceCommand(DSK, {
      ...base,
      payload: command,
    });
    const browserResult = await website.sealBrowserWorkspaceResult(DSK, { ...base, result });

    const tamperedFields: Array<[keyof typeof base, string]> = [
      ['backendId', 'backend-other'],
      ['accountId', 'account-other'],
      ['requestId', 'dashboard-request-other'],
      ['commandId', 'command-other'],
      ['operation', 'file.read'],
      ['workspaceId', 'workspace-other'],
      ['repositoryId', 'repository-other'],
      ['expiresAt', '2099-01-02T00:00:00.000Z'],
    ];

    for (const [field, value] of tamperedFields) {
      const tampered = { ...base, [field]: value } as typeof base;
      await expect(
        website.openBrowserWorkspaceCommand(DSK, browserCommand, tampered),
      ).rejects.toThrow();
      await expect(
        website.openBrowserWorkspaceResult(DSK, browserResult, tampered),
      ).rejects.toThrow();
      expect(() =>
        unsealJsonEnvelope(DSK, browserWorkspaceCommandAssociatedData(tampered), browserCommand),
      ).toThrow();
      expect(() =>
        unsealJsonEnvelope(DSK, browserWorkspaceResultAssociatedData(tampered), browserResult),
      ).toThrow();
    }

    // The command/result domain separators prevent an authenticated envelope
    // from being reflected into the other direction under the same DSK.
    await expect(
      website.openBrowserWorkspaceResult(
        DSK,
        browserCommand as BrowserWorkspaceResultEnvelope,
        base,
      ),
    ).rejects.toThrow();
    await expect(
      website.openBrowserWorkspaceCommand(
        DSK,
        browserResult as BrowserWorkspaceCommandEnvelope,
        base,
      ),
    ).rejects.toThrow();
    expect(() =>
      unsealJsonEnvelope(DSK, browserWorkspaceResultAssociatedData(base), browserCommand),
    ).toThrow();
    expect(() =>
      unsealJsonEnvelope(DSK, browserWorkspaceCommandAssociatedData(base), browserResult),
    ).toThrow();
  });

  it('unwraps a Node-sealed dashboard grant and rejects grant/snapshot tampering', async () => {
    const website = await websiteCrypto();
    const browser = website.generateBrowserKeypair();
    const browserPub = website.encodeBrowserPub(browser.pub);
    const grantParts = {
      backendId: base.backendId,
      accountId: base.accountId,
      requestId: 'grant-request-crypto',
      browserPub,
      expiresAt: base.expiresAt,
    };
    const grantInner = {
      v: 1 as const,
      dsk: DSK.toString('base64'),
      scopes: ['workspace-read', 'workspace-write'],
      expiresAt: grantParts.expiresAt,
      workspace: { workspaceId: base.workspaceId, repoIds: [base.repositoryId] },
      enrollmentId: 'desktop-enrollment-crypto',
    };
    const wrapped = sealToRecipientPub(
      browserPub,
      Buffer.from(JSON.stringify(grantInner), 'utf8'),
      dashboardGrantAssociatedData(grantParts),
    );
    const grant = {
      v: 1 as const,
      enc: 'x25519-aes-256-gcm' as const,
      ...grantParts,
      ...wrapped,
    };

    // This checks both implementations use byte-for-byte identical grant AD.
    expect(website.grantAssociatedData(grantParts)).toBe(dashboardGrantAssociatedData(grantParts));
    const opened = await website.unwrapDashboardGrant(browser.priv, browser.pub, grant, {
      backendId: grantParts.backendId,
      accountId: grantParts.accountId,
    });
    expect(opened).toMatchObject(grantInner);
    expect(Buffer.from(website.decodeDsk(opened!))).toEqual(DSK);

    for (const [field, value] of [
      ['requestId', 'grant-request-other'],
      ['browserPub', website.encodeBrowserPub(randomBytes(32))],
      ['expiresAt', '2099-01-02T00:00:00.000Z'],
    ] as const) {
      await expect(
        website.unwrapDashboardGrant(
          browser.priv,
          browser.pub,
          { ...grant, [field]: value },
          {
            backendId: grantParts.backendId,
            accountId: grantParts.accountId,
          },
        ),
      ).resolves.toBeNull();
    }
    await expect(
      website.unwrapDashboardGrant(browser.priv, browser.pub, grant, {
        backendId: 'backend-other',
        accountId: grantParts.accountId,
      }),
    ).resolves.toBeNull();
    await expect(
      website.unwrapDashboardGrant(browser.priv, browser.pub, grant, {
        backendId: grantParts.backendId,
        accountId: 'account-other',
      }),
    ).resolves.toBeNull();
    await expect(
      website.unwrapDashboardGrant(website.generateBrowserKeypair().priv, browser.pub, grant, {
        backendId: grantParts.backendId,
        accountId: grantParts.accountId,
      }),
    ).resolves.toBeNull();

    const tamperedCt = website.decodeBase64(grant.ct);
    tamperedCt[0] ^= 0xff;
    await expect(
      website.unwrapDashboardGrant(
        browser.priv,
        browser.pub,
        { ...grant, ct: website.encodeBase64(tamperedCt) },
        {
          backendId: grantParts.backendId,
          accountId: grantParts.accountId,
        },
      ),
    ).resolves.toBeNull();

    const snapshotParts = {
      backendId: grantParts.backendId,
      accountId: grantParts.accountId,
      requestId: grantParts.requestId,
    };
    const snapshotValue = { dashboard: 'retained', commandIds: [base.commandId] };
    const snapshot = {
      enc: 'aes-256-gcm' as const,
      seq: 7,
      ...sealJsonEnvelope(
        DSK,
        dashboardSnapshotAssociatedData({ ...snapshotParts, seq: 7 }),
        snapshotValue,
      ),
    };
    expect(await website.openDashboardSnapshot(DSK, snapshot, snapshotParts)).toEqual(
      snapshotValue,
    );
    expect(
      await website.openDashboardSnapshot(DSK, { ...snapshot, seq: 6 }, snapshotParts),
    ).toBeNull();
    expect(
      await website.openDashboardSnapshot(DSK, snapshot, {
        ...snapshotParts,
        requestId: 'request-other',
      }),
    ).toBeNull();
  });
});

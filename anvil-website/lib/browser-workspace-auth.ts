"use client";

import type {
  BrowserWorkspaceCommandEnvelope,
  BrowserWorkspaceOperation,
  BrowserWorkspaceBinding,
  DashboardScope
} from "./hosted/types";

/**
 * Browser-workspace key persistence.
 *
 * X25519 is implemented in mesh-crypto.ts because it is not consistently
 * available in WebCrypto. This store therefore keeps the raw scalar encrypted
 * at rest. IndexedDB stores the AES wrapping key as a non-exportable
 * CryptoKey, so closing and reopening the browser can resume an approved
 * request without putting the X25519 scalar or DSK in sessionStorage.
 *
 * If IndexedDB is unavailable, callers get an explicit memory-only result.
 * The UI can explain that memory-only browsers need to authorize again after
 * closing. It must not pretend sessionStorage survives tab closure.
 */

const DATABASE_NAME = "anvil-browser-workspace-v1";
const DATABASE_VERSION = 1;
const KEY_STORE = "keys";
const WRAP_KEY_STORE_ID = "browser-wrap-key";
const KEY_PREFIX = "anvil.browser-workspace.key.";
const TRUST_PREFIX = "anvil.browser-workspace.trust.";
const COMMAND_PREFIX = "anvil.browser-workspace.command.";
const MAX_PENDING_COMMANDS_PER_REQUEST = 64;
const MAX_PENDING_COMMANDS_TOTAL = 256;
const encoder = new TextEncoder();

export interface BrowserWorkspaceKeyRecord {
  accountScope: string;
  requestId: string;
  browserPub: string;
  challenge: string;
  expiresAt: string;
  origin?: string;
  targetEnrollmentId?: string;
  trustId?: string;
  createdAt?: string;
  privateKey: Uint8Array;
}

export interface BrowserWorkspaceTrustRecord {
  accountScope: string;
  accountId: string;
  trustId: string;
  origin: string;
  targetEnrollmentId: string;
  browserPub: string;
  privateKey: Uint8Array;
  proofKey: Uint8Array;
  expiresAt: string;
  workspaceBindings: BrowserWorkspaceBinding[];
  scopes: DashboardScope[];
  createdAt: string;
}

export type BrowserWorkspacePersistence = "indexeddb" | "memory";

export interface BrowserWorkspaceStoredSession {
  record: BrowserWorkspaceKeyRecord;
  persistence: BrowserWorkspacePersistence;
}

export interface BrowserWorkspacePendingCommand {
  accountScope: string;
  requestId: string;
  command: BrowserWorkspaceCommandEnvelope;
  createdAt: string;
  /** Set only for commands whose host submission may need direct replay after reload. */
  transport?: "machine";
}

type StoredCiphertext = {
  id: string;
  kind?: "session";
  accountScope: string;
  requestId: string;
  targetEnrollmentId?: string;
  trustId?: string;
  origin?: string;
  browserPub: string;
  challenge: string;
  expiresAt: string;
  createdAt?: string;
  nonce: string;
  ct: string;
};

type StoredTrustCiphertext = {
  id: string;
  kind: "trust";
  accountScope: string;
  trustId: string;
  origin: string;
  targetEnrollmentId: string;
  browserPub: string;
  expiresAt: string;
  nonce: string;
  ct: string;
};

type StoredWrapKey = {
  id: typeof WRAP_KEY_STORE_ID;
  key: CryptoKey;
};

type StoredCommandCiphertext = {
  id: string;
  accountScope: string;
  requestId: string;
  commandId: string;
  operation: BrowserWorkspaceOperation;
  workspaceId: string;
  repositoryId?: string;
  expiresAt: string;
  createdAt: string;
  transport?: "machine";
  nonce: string;
  ct: string;
};

const memory = new Map<string, BrowserWorkspaceKeyRecord>();
const trustMemory = new Map<string, BrowserWorkspaceTrustRecord>();
const pendingMemory = new Map<string, BrowserWorkspacePendingCommand>();

function hasBrowserApis(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof indexedDB !== "undefined" &&
    typeof crypto !== "undefined" &&
    crypto.subtle !== undefined
  );
}

function b64encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64decode(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function safeScope(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value)) {
    throw new Error("Invalid browser account scope.");
  }
  return value;
}

function keyId(accountScope: string, requestId: string): string {
  return `${KEY_PREFIX}${safeScope(accountScope)}.${requestId}`;
}

function trustId(accountScope: string, id: string): string {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) throw new Error("Invalid browser trust id.");
  return `${TRUST_PREFIX}${safeScope(accountScope)}.${id}`;
}

function commandKeyId(accountScope: string, requestId: string, commandId: string): string {
  return `${COMMAND_PREFIX}${safeScope(accountScope)}.${requestId}.${commandId}`;
}

function pendingMemoryKey(accountScope: string, requestId: string, commandId: string): string {
  return commandKeyId(accountScope, requestId, commandId);
}

function wipeBytes(...values: Uint8Array[]): void {
  for (const value of values) value.fill(0);
}

function keyAssociatedData(record: Pick<BrowserWorkspaceKeyRecord, "accountScope" | "requestId" | "browserPub" | "expiresAt" | "origin" | "targetEnrollmentId" | "trustId">): Uint8Array {
  if (record.targetEnrollmentId !== undefined || record.trustId !== undefined || record.origin !== undefined) {
    return encoder.encode(JSON.stringify([
      "anvil/browser-workspace-key/v2",
      record.accountScope,
      record.requestId,
      record.browserPub,
      record.expiresAt,
      record.origin ?? "",
      record.targetEnrollmentId ?? "",
      record.trustId ?? ""
    ]));
  }
  return encoder.encode(
    [
      "anvil/browser-workspace-key/v1",
      record.accountScope,
      record.requestId,
      record.browserPub,
      record.expiresAt
    ].join("|")
  );
}

function trustAssociatedData(record: Pick<BrowserWorkspaceTrustRecord, "accountScope" | "trustId" | "origin" | "targetEnrollmentId" | "browserPub" | "expiresAt">): Uint8Array {
  return encoder.encode(JSON.stringify([
    "anvil/browser-workspace-trust/v1",
    record.accountScope,
    record.trustId,
    record.origin,
    record.targetEnrollmentId,
    record.browserPub,
    record.expiresAt
  ]));
}

function commandAssociatedData(command: BrowserWorkspacePendingCommand): Uint8Array {
  const values = [
      "anvil/browser-workspace-pending-command/v1",
      command.accountScope,
      command.requestId,
      command.command.commandId,
      command.command.operation,
      command.command.workspaceId,
      command.command.repositoryId ?? "",
      command.command.expiresAt
    ];
  if (command.transport === "machine") values.push("machine");
  return encoder.encode(values.join("|"));
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB is unavailable."));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(KEY_STORE)) database.createObjectStore(KEY_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
    request.onsuccess = () => resolve(request.result);
  });
}

async function getWrapKey(database: IDBDatabase): Promise<CryptoKey> {
  // Generate outside the transaction. The read and conditional put happen in
  // one serialized readwrite transaction, so two tabs cannot overwrite the
  // first tab's wrapping key and orphan its encrypted scalar.
  const generated = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  const selected = await new Promise<CryptoKey>((resolve, reject) => {
    const tx = database.transaction(KEY_STORE, "readwrite");
    const store = tx.objectStore(KEY_STORE);
    let winner: CryptoKey | undefined;
    const read = store.get(WRAP_KEY_STORE_ID);
    read.onsuccess = () => {
      if (read.result !== undefined) {
        const stored = read.result as StoredWrapKey;
        if (stored.key === undefined) {
          reject(new Error("IndexedDB wrapping key record is malformed."));
          return;
        }
        winner = stored.key;
      } else {
        winner = generated;
        store.put({ id: WRAP_KEY_STORE_ID, key: generated } satisfies StoredWrapKey);
      }
    };
    read.onerror = () => reject(read.error ?? new Error("IndexedDB request failed."));
    tx.oncomplete = () => {
      if (winner === undefined) reject(new Error("IndexedDB did not return a wrapping key."));
      else resolve(winner);
    };
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed."));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted."));
  });
  return selected;
}

async function encryptPrivateKey(
  key: CryptoKey,
  record: BrowserWorkspaceKeyRecord
): Promise<{ nonce: string; ct: string }> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce as BufferSource, additionalData: keyAssociatedData(record) as BufferSource },
    key,
    record.privateKey as BufferSource
  );
  return { nonce: b64encode(nonce), ct: b64encode(new Uint8Array(ciphertext)) };
}

async function encryptTrust(
  key: CryptoKey,
  record: BrowserWorkspaceTrustRecord
): Promise<{ nonce: string; ct: string }> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify({
    accountId: record.accountId,
    privateKey: b64encode(record.privateKey),
    proofKey: b64encode(record.proofKey),
    workspaceBindings: record.workspaceBindings,
    scopes: record.scopes,
    createdAt: record.createdAt
  }));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce as BufferSource, additionalData: trustAssociatedData(record) as BufferSource },
    key,
    plaintext as BufferSource
  );
  return { nonce: b64encode(nonce), ct: b64encode(new Uint8Array(ciphertext)) };
}

async function decryptTrust(
  key: CryptoKey,
  stored: StoredTrustCiphertext
): Promise<BrowserWorkspaceTrustRecord> {
  const metadata = {
    accountScope: stored.accountScope,
    trustId: stored.trustId,
    origin: stored.origin,
    targetEnrollmentId: stored.targetEnrollmentId,
    browserPub: stored.browserPub,
    expiresAt: stored.expiresAt
  };
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64decode(stored.nonce) as BufferSource, additionalData: trustAssociatedData(metadata) as BufferSource },
    key,
    b64decode(stored.ct) as BufferSource
  );
  const value = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
  const privateKey = typeof value.privateKey === "string" ? b64decode(value.privateKey) : new Uint8Array();
  const proofKey = typeof value.proofKey === "string" ? b64decode(value.proofKey) : new Uint8Array();
  if (
    privateKey.byteLength !== 32 || proofKey.byteLength !== 32 ||
    typeof value.accountId !== "string" || typeof value.createdAt !== "string" ||
    !Array.isArray(value.workspaceBindings) || !Array.isArray(value.scopes)
  ) {
    throw new Error("Stored browser trust record is malformed.");
  }
  return {
    ...metadata,
    accountId: value.accountId,
    privateKey,
    proofKey,
    workspaceBindings: value.workspaceBindings as BrowserWorkspaceBinding[],
    scopes: value.scopes as DashboardScope[],
    createdAt: value.createdAt
  };
}

async function decryptPrivateKey(
  key: CryptoKey,
  stored: Pick<StoredCiphertext, "nonce" | "ct">,
  record: BrowserWorkspaceKeyRecord
): Promise<Uint8Array> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: b64decode(stored.nonce) as BufferSource,
      additionalData: keyAssociatedData(record) as BufferSource
    },
    key,
    b64decode(stored.ct) as BufferSource
  );
  const scalar = new Uint8Array(plaintext);
  if (scalar.byteLength !== 32) throw new Error("Stored browser key has the wrong size.");
  return scalar;
}

async function encryptPendingCommand(
  key: CryptoKey,
  command: BrowserWorkspacePendingCommand
): Promise<{ nonce: string; ct: string }> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(command.command));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce as BufferSource,
      additionalData: commandAssociatedData(command) as BufferSource
    },
    key,
    plaintext as BufferSource
  );
  return { nonce: b64encode(nonce), ct: b64encode(new Uint8Array(ciphertext)) };
}

async function decryptPendingCommand(
  key: CryptoKey,
  stored: StoredCommandCiphertext
): Promise<BrowserWorkspacePendingCommand> {
  const metadata: BrowserWorkspacePendingCommand = {
    accountScope: stored.accountScope,
    requestId: stored.requestId,
    createdAt: stored.createdAt,
    ...(stored.transport === "machine" ? { transport: "machine" as const } : {}),
    command: {
      v: 1,
      enc: "aes-256-gcm",
      requestId: stored.requestId,
      commandId: stored.commandId,
      operation: stored.operation,
      workspaceId: stored.workspaceId,
      ...(stored.repositoryId === undefined ? {} : { repositoryId: stored.repositoryId }),
      expiresAt: stored.expiresAt,
      nonce: "",
      ct: ""
    }
  };
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: b64decode(stored.nonce) as BufferSource,
      additionalData: commandAssociatedData(metadata) as BufferSource
    },
    key,
    b64decode(stored.ct) as BufferSource
  );
  const command = JSON.parse(new TextDecoder().decode(plaintext)) as BrowserWorkspaceCommandEnvelope;
  const result: BrowserWorkspacePendingCommand = {
    accountScope: stored.accountScope,
    requestId: stored.requestId,
    command,
    createdAt: stored.createdAt,
    ...(stored.transport === "machine" ? { transport: "machine" as const } : {})
  };
  // The row's clear metadata is checked before returning the decrypted envelope.
  if (
    command.requestId !== stored.requestId ||
    command.commandId !== stored.commandId ||
    command.expiresAt !== stored.expiresAt
  ) {
    throw new Error("Stored browser command metadata does not match its envelope.");
  }
  return result;
}

async function persistIndexedDb(record: BrowserWorkspaceKeyRecord): Promise<void> {
  const database = await openDatabase();
  try {
    const wrapKey = await getWrapKey(database);
    const encrypted = await encryptPrivateKey(wrapKey, record);
    const stored: StoredCiphertext = {
      id: keyId(record.accountScope, record.requestId),
      kind: "session",
      accountScope: record.accountScope,
      requestId: record.requestId,
      ...(record.origin === undefined ? {} : { origin: record.origin }),
      ...(record.targetEnrollmentId === undefined ? {} : { targetEnrollmentId: record.targetEnrollmentId }),
      ...(record.trustId === undefined ? {} : { trustId: record.trustId }),
      browserPub: record.browserPub,
      challenge: record.challenge,
      expiresAt: record.expiresAt,
      ...(record.createdAt === undefined ? {} : { createdAt: record.createdAt }),
      ...encrypted
    };
    const tx = database.transaction(KEY_STORE, "readwrite");
    tx.objectStore(KEY_STORE).put(stored);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed."));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted."));
    });
  } finally {
    database.close();
  }
}

async function persistTrustIndexedDb(record: BrowserWorkspaceTrustRecord): Promise<void> {
  const database = await openDatabase();
  try {
    const wrapKey = await getWrapKey(database);
    const encrypted = await encryptTrust(wrapKey, record);
    const stored: StoredTrustCiphertext = {
      id: trustId(record.accountScope, record.trustId),
      kind: "trust",
      accountScope: record.accountScope,
      trustId: record.trustId,
      origin: record.origin,
      targetEnrollmentId: record.targetEnrollmentId,
      browserPub: record.browserPub,
      expiresAt: record.expiresAt,
      ...encrypted
    };
    const tx = database.transaction(KEY_STORE, "readwrite");
    tx.objectStore(KEY_STORE).put(stored);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed."));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted."));
    });
  } finally {
    database.close();
  }
}

async function loadTrustIndexedDb(accountScope: string, id: string): Promise<BrowserWorkspaceTrustRecord | null> {
  const database = await openDatabase();
  try {
    const stored = await idbRequest<StoredTrustCiphertext | undefined>(
      database.transaction(KEY_STORE, "readonly").objectStore(KEY_STORE).get(trustId(accountScope, id))
    );
    if (stored === undefined || stored.kind !== "trust") return null;
    return await decryptTrust(await getWrapKey(database), stored);
  } finally {
    database.close();
  }
}

async function listTrustIndexedDb(accountScope: string): Promise<BrowserWorkspaceTrustRecord[]> {
  const database = await openDatabase();
  try {
    const rows = await idbRequest<Array<StoredCiphertext | StoredTrustCiphertext>>(
      database.transaction(KEY_STORE, "readonly").objectStore(KEY_STORE).getAll()
    );
    const wrapKey = await getWrapKey(database);
    const trusts: BrowserWorkspaceTrustRecord[] = [];
    for (const row of rows) {
      if (row.kind !== "trust" || row.accountScope !== accountScope) continue;
      try {
        trusts.push(await decryptTrust(wrapKey, row as StoredTrustCiphertext));
      } catch {
        // Corrupt trust material must never be used to renew a session.
      }
    }
    return trusts;
  } finally {
    database.close();
  }
}

async function persistPendingCommandIndexedDb(command: BrowserWorkspacePendingCommand): Promise<void> {
  const database = await openDatabase();
  try {
    const wrapKey = await getWrapKey(database);
    const encrypted = await encryptPendingCommand(wrapKey, command);
    const stored: StoredCommandCiphertext = {
      id: commandKeyId(command.accountScope, command.requestId, command.command.commandId),
      accountScope: command.accountScope,
      requestId: command.requestId,
      commandId: command.command.commandId,
      operation: command.command.operation,
      workspaceId: command.command.workspaceId,
      ...(command.command.repositoryId === undefined
        ? {}
        : { repositoryId: command.command.repositoryId }),
      expiresAt: command.command.expiresAt,
      createdAt: command.createdAt,
      ...(command.transport === "machine" ? { transport: "machine" as const } : {}),
      ...encrypted
    };
    const tx = database.transaction(KEY_STORE, "readwrite");
    tx.objectStore(KEY_STORE).put(stored);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed."));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted."));
    });
  } finally {
    database.close();
  }
}

async function loadIndexedDb(accountScope: string, requestId: string): Promise<BrowserWorkspaceKeyRecord | null> {
  const database = await openDatabase();
  try {
    const row = await idbRequest<StoredCiphertext | undefined>(
      database.transaction(KEY_STORE, "readonly").objectStore(KEY_STORE).get(keyId(accountScope, requestId))
    );
    if (row === undefined) return null;
    const record: BrowserWorkspaceKeyRecord = {
      accountScope,
      requestId: row.requestId,
      browserPub: row.browserPub,
      challenge: row.challenge,
      expiresAt: row.expiresAt,
      ...(row.targetEnrollmentId === undefined ? {} : { targetEnrollmentId: row.targetEnrollmentId }),
      ...(row.trustId === undefined ? {} : { trustId: row.trustId }),
      ...(row.origin === undefined ? {} : { origin: row.origin }),
      ...(row.createdAt === undefined ? {} : { createdAt: row.createdAt }),
      privateKey: new Uint8Array(0)
    };
    const wrapKey = await getWrapKey(database);
    record.privateKey = await decryptPrivateKey(wrapKey, row, record);
    return record;
  } finally {
    database.close();
  }
}

async function removeIndexedDb(accountScope: string, requestId: string): Promise<void> {
  const database = await openDatabase();
  try {
    const tx = database.transaction(KEY_STORE, "readwrite");
    tx.objectStore(KEY_STORE).delete(keyId(accountScope, requestId));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed."));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted."));
    });
  } finally {
    database.close();
  }
}

async function removePendingCommandIndexedDb(
  accountScope: string,
  requestId: string,
  commandId: string
): Promise<void> {
  const database = await openDatabase();
  try {
    const tx = database.transaction(KEY_STORE, "readwrite");
    tx.objectStore(KEY_STORE).delete(commandKeyId(accountScope, requestId, commandId));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed."));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted."));
    });
  } finally {
    database.close();
  }
}

export class BrowserWorkspaceKeyStore {
  constructor() {}

  clearMemory(accountScope: string): void {
    const normalizedScope = safeScope(accountScope);
    for (const key of [...memory.keys()]) {
      if (key.startsWith(`${KEY_PREFIX}${normalizedScope}.`)) {
        const record = memory.get(key);
        if (record !== undefined) wipeBytes(record.privateKey);
        memory.delete(key);
      }
    }
    for (const key of [...trustMemory.keys()]) {
      if (key.startsWith(`${TRUST_PREFIX}${normalizedScope}.`)) {
        const record = trustMemory.get(key);
        if (record !== undefined) wipeBytes(record.privateKey, record.proofKey);
        trustMemory.delete(key);
      }
    }
    for (const key of [...pendingMemory.keys()]) {
      if (key.startsWith(`${COMMAND_PREFIX}${normalizedScope}.`)) pendingMemory.delete(key);
    }
  }

  clearSessionMemory(accountScope: string): void {
    const normalizedScope = safeScope(accountScope);
    for (const key of [...memory.keys()]) {
      if (key.startsWith(`${KEY_PREFIX}${normalizedScope}.`)) {
        const record = memory.get(key);
        if (record !== undefined) wipeBytes(record.privateKey);
        memory.delete(key);
      }
    }
    for (const key of [...pendingMemory.keys()]) {
      if (key.startsWith(`${COMMAND_PREFIX}${normalizedScope}.`)) pendingMemory.delete(key);
    }
  }

  async save(record: BrowserWorkspaceKeyRecord): Promise<BrowserWorkspacePersistence> {
    const normalized = { ...record, accountScope: safeScope(record.accountScope) };
    const id = keyId(normalized.accountScope, normalized.requestId);
    const previous = memory.get(id);
    if (previous !== undefined) wipeBytes(previous.privateKey);
    memory.set(id, {
      ...normalized,
      privateKey: new Uint8Array(normalized.privateKey)
    });
    if (hasBrowserApis()) {
      try {
        await persistIndexedDb(normalized);
        return "indexeddb";
      } catch {
        // Fall through to memory-only, and let the caller show that state.
      }
    }
    return "memory";
  }

  async saveTrust(record: BrowserWorkspaceTrustRecord): Promise<BrowserWorkspacePersistence> {
    const normalized: BrowserWorkspaceTrustRecord = {
      ...record,
      accountScope: safeScope(record.accountScope),
      privateKey: new Uint8Array(record.privateKey),
      proofKey: new Uint8Array(record.proofKey),
      workspaceBindings: record.workspaceBindings.map((binding) => ({
        workspaceId: binding.workspaceId,
        repositoryIds: [...binding.repositoryIds]
      })),
      scopes: [...record.scopes]
    };
    const id = trustId(normalized.accountScope, normalized.trustId);
    const previous = trustMemory.get(id);
    if (previous !== undefined) wipeBytes(previous.privateKey, previous.proofKey);
    trustMemory.set(id, normalized);
    if (hasBrowserApis()) {
      try {
        await persistTrustIndexedDb(normalized);
        return "indexeddb";
      } catch {
        // Memory-only trust cannot survive closing this browser.
      }
    }
    return "memory";
  }

  async loadTrust(accountScope: string, id: string): Promise<BrowserWorkspaceTrustRecord | null> {
    const normalizedScope = safeScope(accountScope);
    if (hasBrowserApis()) {
      try {
        const record = await loadTrustIndexedDb(normalizedScope, id);
        if (record !== null) return record;
      } catch {
        // Use the session-only copy if durable storage is unavailable.
      }
    }
    const record = trustMemory.get(trustId(normalizedScope, id));
    return record === undefined
      ? null
      : {
          ...record,
          privateKey: new Uint8Array(record.privateKey),
          proofKey: new Uint8Array(record.proofKey),
          workspaceBindings: record.workspaceBindings.map((binding) => ({
            workspaceId: binding.workspaceId,
            repositoryIds: [...binding.repositoryIds]
          })),
          scopes: [...record.scopes]
        };
  }

  async findTrust(
    accountScope: string,
    origin: string,
    targetEnrollmentId: string
  ): Promise<BrowserWorkspaceTrustRecord | null> {
    const normalizedScope = safeScope(accountScope);
    let records: BrowserWorkspaceTrustRecord[] = [];
    if (hasBrowserApis()) {
      try {
        records = await listTrustIndexedDb(normalizedScope);
      } catch {
        // In-memory trust is the session-only fallback.
      }
    }
    if (records.length === 0) {
      records = [...trustMemory.values()].filter((record) => record.accountScope === normalizedScope);
    }
    const found = records
      .filter(
        (record) =>
          record.origin === origin &&
          record.targetEnrollmentId === targetEnrollmentId &&
          Date.parse(record.expiresAt) > Date.now()
      )
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (found === undefined) return null;
    return {
      ...found,
      privateKey: new Uint8Array(found.privateKey),
      proofKey: new Uint8Array(found.proofKey),
      workspaceBindings: found.workspaceBindings.map((binding) => ({
        workspaceId: binding.workspaceId,
        repositoryIds: [...binding.repositoryIds]
      })),
      scopes: [...found.scopes]
    };
  }

  async listTrusts(accountScope: string): Promise<BrowserWorkspaceTrustRecord[]> {
    const normalizedScope = safeScope(accountScope);
    let records: BrowserWorkspaceTrustRecord[] = [];
    if (hasBrowserApis()) {
      try {
        records = await listTrustIndexedDb(normalizedScope);
      } catch {
        // Return session-only trust material below.
      }
    }
    if (records.length === 0) {
      records = [...trustMemory.values()].filter((record) => record.accountScope === normalizedScope);
    }
    return records.map((record) => ({
      ...record,
      privateKey: new Uint8Array(record.privateKey),
      proofKey: new Uint8Array(record.proofKey),
      workspaceBindings: record.workspaceBindings.map((binding) => ({
        workspaceId: binding.workspaceId,
        repositoryIds: [...binding.repositoryIds]
      })),
      scopes: [...record.scopes]
    }));
  }

  async removeTrust(accountScope: string, id: string): Promise<void> {
    const normalizedScope = safeScope(accountScope);
    const key = trustId(normalizedScope, id);
    const storedTrust = trustMemory.get(key);
    if (storedTrust !== undefined) wipeBytes(storedTrust.privateKey, storedTrust.proofKey);
    trustMemory.delete(key);
    const requestIds = new Set<string>();
    for (const [sessionKey, record] of memory) {
      if (record.accountScope === normalizedScope && record.trustId === id) {
        requestIds.add(record.requestId);
        wipeBytes(record.privateKey);
        memory.delete(sessionKey);
      }
    }
    for (const [commandKey, command] of pendingMemory) {
      if (command.accountScope === normalizedScope && requestIds.has(command.requestId)) {
        pendingMemory.delete(commandKey);
      }
    }
    if (!hasBrowserApis()) return;
    try {
      const database = await openDatabase();
      try {
        const rows = await idbRequest<Array<StoredCiphertext | StoredTrustCiphertext | StoredCommandCiphertext>>(
          database.transaction(KEY_STORE, "readonly").objectStore(KEY_STORE).getAll()
        );
        const tx = database.transaction(KEY_STORE, "readwrite");
        const store = tx.objectStore(KEY_STORE);
        for (const row of rows) {
          if (
            row.accountScope === normalizedScope &&
            "requestId" in row &&
            "trustId" in row &&
            row.trustId === id
          ) {
            requestIds.add(row.requestId);
          }
        }
        for (const row of rows) {
          if (
            row.accountScope === normalizedScope &&
            (row.id === key ||
              ("trustId" in row && row.trustId === id) ||
              ("operation" in row && requestIds.has(row.requestId)))
          ) {
            store.delete(row.id);
          }
        }
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed."));
          tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted."));
        });
      } finally {
        database.close();
      }
    } catch {
      // Remote revocation is authoritative; local deletion is best effort.
    }
  }

  async load(accountScope: string, requestId: string): Promise<BrowserWorkspaceStoredSession | null> {
    const normalizedScope = safeScope(accountScope);
    if (hasBrowserApis()) {
      try {
        const record = await loadIndexedDb(normalizedScope, requestId);
        if (record !== null) return { record, persistence: "indexeddb" };
      } catch {
        // Memory fallback below.
      }
    }
    const record = memory.get(keyId(normalizedScope, requestId));
    return record === undefined
      ? null
      : { record: { ...record, privateKey: new Uint8Array(record.privateKey) }, persistence: "memory" };
  }

  async savePendingCommand(command: BrowserWorkspacePendingCommand): Promise<BrowserWorkspacePersistence> {
    const normalizedScope = safeScope(command.accountScope);
    const normalized: BrowserWorkspacePendingCommand = {
      ...command,
      accountScope: normalizedScope,
      command: { ...command.command }
    };
    const now = Date.now();
    for (const [id, item] of pendingMemory) {
      if (Date.parse(item.command.expiresAt) <= now) pendingMemory.delete(id);
    }
    const totalLiveMemoryCommands = pendingMemory.size;
    const memoryCommands = [...pendingMemory.values()].filter(
      (item) =>
        item.accountScope === normalizedScope && item.requestId === normalized.requestId
    );
    const isReplacement = memoryCommands.some(
      (item) => item.command.commandId === normalized.command.commandId
    );
    const liveMemoryCommands = memoryCommands.filter(
      (item) => Date.parse(item.command.expiresAt) > Date.now()
    );
    if (!isReplacement && liveMemoryCommands.length >= MAX_PENDING_COMMANDS_PER_REQUEST) {
      throw new Error("Too many pending browser workspace commands; wait for one to finish.");
    }
    if (!isReplacement && totalLiveMemoryCommands >= MAX_PENDING_COMMANDS_TOTAL) {
      throw new Error("Too many pending browser workspace commands; wait for one to finish.");
    }
    if (hasBrowserApis()) {
      try {
        const existing = await this.listPendingCommands(normalizedScope, normalized.requestId);
        const allExisting = await this.listPendingCommands(normalizedScope);
        const now = Date.now();
        const live = existing.filter((item) => Date.parse(item.command.expiresAt) > now);
        const allLive = allExisting.filter((item) => Date.parse(item.command.expiresAt) > now);
        const existingCommand = live.find(
          (item) => item.command.commandId === normalized.command.commandId
        );
        if (existingCommand === undefined && live.length >= MAX_PENDING_COMMANDS_PER_REQUEST) {
          throw new Error("Too many pending browser workspace commands; wait for one to finish.");
        }
        if (
          existingCommand === undefined &&
          allLive.length >= MAX_PENDING_COMMANDS_TOTAL
        ) {
          throw new Error("Too many pending browser workspace commands; wait for one to finish.");
        }
        for (const item of existing) {
          if (Date.parse(item.command.expiresAt) <= now) {
            await removePendingCommandIndexedDb(
              normalizedScope,
              item.requestId,
              item.command.commandId
            );
          }
        }
        await persistPendingCommandIndexedDb(normalized);
        pendingMemory.set(
          pendingMemoryKey(normalizedScope, normalized.requestId, normalized.command.commandId),
          normalized
        );
        return "indexeddb";
      } catch (error) {
        // Preserve the explicit capacity error rather than silently evicting
        // an unresolved mutation from its reconnect record.
        if (error instanceof Error && error.message.startsWith("Too many pending")) {
          throw error;
        }
        if (liveMemoryCommands.length >= MAX_PENDING_COMMANDS_PER_REQUEST && !isReplacement) {
          throw new Error("Too many pending browser workspace commands; wait for one to finish.");
        }
        // Fall through to memory-only, and let the caller retain the command
        // id so a reconnect can ask for its outcome without reissuing it.
      }
    }
    pendingMemory.set(
      pendingMemoryKey(normalizedScope, normalized.requestId, normalized.command.commandId),
      normalized
    );
    return "memory";
  }

  async listPendingCommands(
    accountScope: string,
    requestId?: string
  ): Promise<BrowserWorkspacePendingCommand[]> {
    const normalizedScope = safeScope(accountScope);
    const result: BrowserWorkspacePendingCommand[] = [];
    if (hasBrowserApis()) {
      try {
        const database = await openDatabase();
        try {
          const rows = await idbRequest<Array<StoredCommandCiphertext | StoredCiphertext>>(
            database.transaction(KEY_STORE, "readonly").objectStore(KEY_STORE).getAll()
          );
          const wrapKey = await getWrapKey(database);
          for (const row of rows) {
            if (
              !("operation" in row) ||
              row.accountScope !== normalizedScope ||
              (requestId !== undefined && row.requestId !== requestId)
            ) {
              continue;
            }
            try {
              result.push(await decryptPendingCommand(wrapKey, row as StoredCommandCiphertext));
            } catch {
              // A corrupt row cannot be safely resumed.
            }
          }
        } finally {
          database.close();
        }
      } catch {
        // Memory fallback below.
      }
    }
    if (result.length > 0) return result;
    for (const [id, command] of pendingMemory) {
      if (!id.startsWith(`${COMMAND_PREFIX}${normalizedScope}.`)) continue;
      if (requestId !== undefined && command.requestId !== requestId) continue;
      result.push({ ...command, command: { ...command.command } });
    }
    return result;
  }

  async removePendingCommand(accountScope: string, requestId: string, commandId: string): Promise<void> {
    const normalizedScope = safeScope(accountScope);
    pendingMemory.delete(pendingMemoryKey(normalizedScope, requestId, commandId));
    if (hasBrowserApis()) {
      try {
        await removePendingCommandIndexedDb(normalizedScope, requestId, commandId);
      } catch {
        // Best effort; no command is reissued automatically after a failure.
      }
    }
  }

  async list(accountScope: string): Promise<BrowserWorkspaceStoredSession[]> {
    const normalizedScope = safeScope(accountScope);
    const result: BrowserWorkspaceStoredSession[] = [];
    if (hasBrowserApis()) {
      try {
        const database = await openDatabase();
        try {
          const rows = await idbRequest<Array<StoredCiphertext | StoredTrustCiphertext>>(
            database.transaction(KEY_STORE, "readonly").objectStore(KEY_STORE).getAll()
          );
          const wrapKey = await getWrapKey(database);
          for (const row of rows) {
            if (row.kind === "trust" || row.accountScope !== normalizedScope) continue;
            try {
              const record: BrowserWorkspaceKeyRecord = {
                accountScope: normalizedScope,
                requestId: row.requestId,
                browserPub: row.browserPub,
                challenge: row.challenge,
                expiresAt: row.expiresAt,
                ...(row.origin === undefined ? {} : { origin: row.origin }),
                ...(row.targetEnrollmentId === undefined ? {} : { targetEnrollmentId: row.targetEnrollmentId }),
                ...(row.trustId === undefined ? {} : { trustId: row.trustId }),
                ...(row.createdAt === undefined ? {} : { createdAt: row.createdAt }),
                privateKey: new Uint8Array(0)
              };
              record.privateKey = await decryptPrivateKey(wrapKey, row, record);
              result.push({ record, persistence: "indexeddb" });
            } catch {
              // A corrupt row is ignored. It cannot authenticate a grant.
            }
          }
        } finally {
          database.close();
        }
      } catch {
        // Memory fallback below.
      }
    }
    if (result.length > 0) return result;
    for (const [id, record] of memory) {
      if (!id.startsWith(`${KEY_PREFIX}${normalizedScope}.`)) continue;
      result.push({ record: { ...record, privateKey: new Uint8Array(record.privateKey) }, persistence: "memory" });
    }
    return result;
  }

  async remove(accountScope: string, requestId: string): Promise<void> {
    const normalizedScope = safeScope(accountScope);
    const id = keyId(normalizedScope, requestId);
    const record = memory.get(id);
    if (record !== undefined) wipeBytes(record.privateKey);
    memory.delete(id);
    if (hasBrowserApis()) {
      try {
        await removeIndexedDb(normalizedScope, requestId);
      } catch {
        // Best effort. The in-memory copy is dropped even if persistence
        // deletion fails; callers can surface that failure when needed.
      }
    }
  }

  async clearAccount(accountScope: string): Promise<void> {
    const normalizedScope = safeScope(accountScope);
    const pending = [...memory.keys()].filter((key) => key.startsWith(`${KEY_PREFIX}${normalizedScope}.`));
    for (const key of pending) {
      const record = memory.get(key);
      if (record !== undefined) wipeBytes(record.privateKey);
      memory.delete(key);
    }
    for (const key of [...trustMemory.keys()]) {
      if (key.startsWith(`${TRUST_PREFIX}${normalizedScope}.`)) {
        const record = trustMemory.get(key);
        if (record !== undefined) wipeBytes(record.privateKey, record.proofKey);
        trustMemory.delete(key);
      }
    }
    for (const key of [...pendingMemory.keys()]) {
      if (key.startsWith(`${COMMAND_PREFIX}${normalizedScope}.`)) pendingMemory.delete(key);
    }
    if (hasBrowserApis()) {
      try {
        const database = await openDatabase();
        try {
          const rows = await idbRequest<Array<{ id: string; accountScope: string }>>(
            database.transaction(KEY_STORE, "readonly").objectStore(KEY_STORE).getAll()
          );
          const tx = database.transaction(KEY_STORE, "readwrite");
          for (const row of rows) {
            if (row.accountScope === normalizedScope) tx.objectStore(KEY_STORE).delete(row.id);
          }
          await new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed."));
            tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted."));
          });
        } finally {
          database.close();
        }
      } catch {
        // Best effort. Callers still drop all in-memory key material.
      }
    }
  }
}

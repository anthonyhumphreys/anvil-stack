"use client";

import type {
  BrowserWorkspaceCommandEnvelope,
  BrowserWorkspaceOperation
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
  createdAt?: string;
  privateKey: Uint8Array;
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
}

type StoredCiphertext = {
  id: string;
  accountScope: string;
  requestId: string;
  browserPub: string;
  challenge: string;
  expiresAt: string;
  createdAt?: string;
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
  nonce: string;
  ct: string;
};

const memory = new Map<string, BrowserWorkspaceKeyRecord>();
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

function commandKeyId(accountScope: string, requestId: string, commandId: string): string {
  return `${COMMAND_PREFIX}${safeScope(accountScope)}.${requestId}.${commandId}`;
}

function pendingMemoryKey(accountScope: string, requestId: string, commandId: string): string {
  return commandKeyId(accountScope, requestId, commandId);
}

function keyAssociatedData(record: Pick<BrowserWorkspaceKeyRecord, "accountScope" | "requestId" | "browserPub" | "expiresAt">): Uint8Array {
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

function commandAssociatedData(command: BrowserWorkspacePendingCommand): Uint8Array {
  return encoder.encode(
    [
      "anvil/browser-workspace-pending-command/v1",
      command.accountScope,
      command.requestId,
      command.command.commandId,
      command.command.operation,
      command.command.workspaceId,
      command.command.repositoryId ?? "",
      command.command.expiresAt
    ].join("|")
  );
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
    createdAt: stored.createdAt
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
      accountScope: record.accountScope,
      requestId: record.requestId,
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

  async save(record: BrowserWorkspaceKeyRecord): Promise<BrowserWorkspacePersistence> {
    const normalized = { ...record, accountScope: safeScope(record.accountScope) };
    memory.set(keyId(normalized.accountScope, normalized.requestId), {
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
          const rows = await idbRequest<StoredCiphertext[]>(
            database.transaction(KEY_STORE, "readonly").objectStore(KEY_STORE).getAll()
          );
          const wrapKey = await getWrapKey(database);
          for (const row of rows) {
            if (row.accountScope !== normalizedScope) continue;
            try {
              const record: BrowserWorkspaceKeyRecord = {
                accountScope: normalizedScope,
                requestId: row.requestId,
                browserPub: row.browserPub,
                challenge: row.challenge,
                expiresAt: row.expiresAt,
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
    memory.delete(keyId(normalizedScope, requestId));
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
      memory.delete(key);
    }
    for (const key of [...pendingMemory.keys()]) {
      if (key.startsWith(`${COMMAND_PREFIX}${normalizedScope}.`)) pendingMemory.delete(key);
    }
    if (hasBrowserApis()) {
      try {
        const database = await openDatabase();
        try {
          const rows = await idbRequest<StoredCiphertext[]>(
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

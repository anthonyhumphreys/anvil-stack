"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  dashboardVerificationCode,
  decodeBase64,
  decodeDsk,
  encodeBase64,
  generateBrowserKeypair,
  hmacSha256,
  openBrowserWorkspaceResult,
  randomChallenge,
  randomRequestId,
  sealBrowserWorkspaceCommand,
  unwrapDashboardGrant,
  type DashboardGrantEnvelope,
  type DashboardGrantInner
} from "@/lib/mesh-crypto";
import {
  browserWorkspaceCommandStatusAction,
  browserWorkspaceStatusAction,
  requestBrowserWorkspaceAccessAction,
  revokeBrowserWorkspaceGrantAction,
  revokeBrowserWorkspaceTrustAction,
  submitBrowserWorkspaceCommandAction,
  issueBrowserWorkspaceMachineAdmissionAction,
  type BrowserWorkspaceAccessRequest,
  type BrowserWorkspaceActionResult
} from "@/app/account/workspace/actions";
import {
  BrowserMachineWorkspaceTransport,
  BrowserMachineTransportError,
  browserMachineRouteCandidates,
  type BrowserMachineStreamHandlers,
} from "@/lib/browser-workspace-transport";
import type { MeshMachineHost } from "../../anvil-app/cloud/contract/machine.js";
import {
  BROWSER_WORKSPACE_OPERATION_SCOPE,
  BROWSER_WORKSPACE_OPERATIONS,
  type BrowserWorkspaceCommandEnvelope,
  type BrowserWorkspaceOperation,
  type BrowserWorkspaceResultEnvelope,
  type BrowserWorkspaceBinding,
  type DashboardCommandState,
  type DashboardScope,
  type HostedDashboardRequestResult,
  type HostedDashboardStatus
} from "@/lib/hosted/types";
import { dashboardRenewalProofMessage } from "@/lib/hosted/types";
import {
  BrowserWorkspaceKeyStore,
  type BrowserWorkspaceKeyRecord,
  type BrowserWorkspacePersistence,
  type BrowserWorkspaceTrustRecord
} from "@/lib/browser-workspace-auth";

const REQUEST_TTL_MS = 60 * 60_000;
const COMMAND_TTL_MS = 5 * 60_000;
// Keep command status reads bounded; each submitted command already consumes a
// retained coordinator row, so a tight read loop only adds load without
// changing the command outcome.
const POLL_INTERVAL_MS = 1_500;
const DEFAULT_POLL_TIMEOUT_MS = 30_000;
const TRUST_RENEWAL_WINDOW_MS = 5 * 60_000;
const TRUST_HARD_MAX_MS = 30 * 24 * 60 * 60_000;
const useSynchronousBrowserEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export type BrowserWorkspaceAuthStatus = "locked" | "pending" | "ready" | "ended";

export interface BrowserWorkspaceWorkspaceGrant {
  workspaceId: string;
  repoIds: string[];
  enrollmentId: string;
}

export interface BrowserWorkspaceAuth {
  status: BrowserWorkspaceAuthStatus;
  requestId: string | null;
  accountId: string | null;
  backendId: string | null;
  expiresAt: string | null;
  trustExpiresAt: string | null;
  remembered: boolean;
  renewing: boolean;
  scopes: readonly DashboardScope[];
  workspace: BrowserWorkspaceWorkspaceGrant | null;
  persistence: BrowserWorkspacePersistence | null;
  /**
   * While pending, the code shown beside this request in the Desktop approval
   * panel — the user confirms the two match before approving.
   */
  verificationCode?: string;
  reason?: "denied" | "expired" | "revoked" | "unavailable";
}

export interface BrowserWorkspaceRequestOptions {
  targetEnrollmentId: string;
}

export interface BrowserWorkspaceCommandInput {
  operation: BrowserWorkspaceOperation;
  workspaceId: string;
  repositoryId?: string;
  payload: unknown;
  expiresInMs?: number;
}

export interface BrowserWorkspaceCommandMetadata {
  commandId: string;
  requestId: string;
  operation: BrowserWorkspaceOperation;
  workspaceId: string;
  repositoryId?: string;
  expiresAt: string;
}

export interface BrowserWorkspaceExecution<T = unknown> extends BrowserWorkspaceCommandMetadata {
  state: DashboardCommandState;
  ok: boolean;
  uncertain: boolean;
  data?: T;
  error?: { code: string; message: string };
}

export interface BrowserWorkspaceHookOptions {
  /** WorkOS user id from loadAccountContext. It scopes IndexedDB records. */
  accountScope: string;
  /** Trusted host routes from the signed WorkOS-scoped discovery response. */
  meshHosts?: readonly MeshMachineHost[];
  /** Opt into polling for a stored pending request on initial render. */
  resumeStoredSession?: boolean;
}

export interface BrowserWorkspaceDirectStatus {
  state: "connecting" | "live" | "fallback";
  detail?: string;
}

export class BrowserWorkspaceCommandError extends Error {
  readonly commandId: string;
  readonly uncertain: boolean;

  constructor(commandId: string, message: string, uncertain: boolean) {
    super(message);
    this.name = "BrowserWorkspaceCommandError";
    this.commandId = commandId;
    this.uncertain = uncertain;
  }
}

/** Clears persisted browser-workspace authorization material for logout/revoke flows. */
export async function clearBrowserWorkspaceAccount(accountScope: string): Promise<void> {
  await new BrowserWorkspaceKeyStore().clearAccount(accountScope);
}

interface PendingPhase {
  kind: "pending";
  record: BrowserWorkspaceKeyRecord;
  persistence: BrowserWorkspacePersistence;
  renewal: boolean;
}

interface ReadyPhase {
  kind: "ready";
  record: BrowserWorkspaceKeyRecord;
  persistence: BrowserWorkspacePersistence;
  accountId: string;
  backendId: string;
  dsk: Uint8Array;
  expiresAt: string;
  scopes: DashboardScope[];
  workspace: BrowserWorkspaceWorkspaceGrant;
  trustId?: string;
  trustExpiresAt?: string;
  remembered: boolean;
  origin: string;
}

type Phase =
  | { kind: "locked" }
  | PendingPhase
  | ReadyPhase
  | { kind: "ended"; reason: NonNullable<BrowserWorkspaceAuth["reason"]> };

interface TrackedCommand extends BrowserWorkspaceCommandMetadata {
  dsk: Uint8Array;
  accountId: string;
  backendId: string;
  generation: number;
  trustId?: string;
  transport?: "machine";
}

const TERMINAL_STATES = new Set<DashboardCommandState>([
  "completed",
  "failed",
  "expired",
  "revoked",
  "unknown-outcome"
]);
const DIRECT_READ_OPERATIONS = new Set<BrowserWorkspaceOperation>([
  "workspace.get",
  "repo.list",
  "file.list",
  "file.read",
  "chat.thread.list",
  "chat.execution.options",
  "chat.history.read",
  "chat.status",
  "git.status",
  "git.diff",
  "workflow.list",
  "workflow.get",
  "terminal.read",
  "preview.screenshot",
]);

interface DirectCommandDispatch {
  commandId: string;
  state: "completed" | "failed" | "uncertain" | "processing" | "not-ready";
  result?: BrowserWorkspaceResultEnvelope;
}

function isOperation(value: string): value is BrowserWorkspaceOperation {
  return (BROWSER_WORKSPACE_OPERATIONS as readonly string[]).includes(value);
}

function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,200}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function grantWorkspace(inner: DashboardGrantInner): BrowserWorkspaceWorkspaceGrant | null {
  let workspace: { workspaceId: unknown; repoIds: unknown } | null = null;
  if (inner.workspaceBindings !== undefined) {
    if (!Array.isArray(inner.workspaceBindings) || inner.workspaceBindings.length !== 1) return null;
    const binding: unknown = inner.workspaceBindings[0];
    if (!isRecord(binding)) return null;
    workspace = { workspaceId: binding.workspaceId, repoIds: binding.repositoryIds };
  } else if (inner.workspace !== undefined) {
    const legacy: unknown = inner.workspace;
    if (!isRecord(legacy)) return null;
    workspace = { workspaceId: legacy.workspaceId, repoIds: legacy.repoIds };
  }
  if (
    !workspace ||
    typeof workspace.workspaceId !== "string" ||
    !isSafeId(workspace.workspaceId) ||
    !Array.isArray(workspace.repoIds) ||
    workspace.repoIds.length === 0 ||
    workspace.repoIds.some((repoId) => typeof repoId !== "string" || !isSafeId(repoId)) ||
    typeof inner.enrollmentId !== "string" ||
    !isSafeId(inner.enrollmentId)
  ) {
    return null;
  }
  return {
    workspaceId: workspace.workspaceId,
    repoIds: [...new Set(workspace.repoIds)],
    enrollmentId: inner.enrollmentId
  };
}

function initialAuth(): BrowserWorkspaceAuth {
  return {
    status: "locked",
    requestId: null,
    accountId: null,
    backendId: null,
    expiresAt: null,
    trustExpiresAt: null,
    remembered: false,
    renewing: false,
    scopes: [],
    workspace: null,
    persistence: null
  };
}

function toAuth(phase: Phase): BrowserWorkspaceAuth {
  if (phase.kind === "locked") return initialAuth();
  if (phase.kind === "ended") return { ...initialAuth(), status: "ended", reason: phase.reason };
  if (phase.kind === "pending") {
    return {
      ...initialAuth(),
      status: "pending",
      requestId: phase.record.requestId,
      expiresAt: phase.record.expiresAt,
      trustExpiresAt: null,
      remembered: false,
      renewing: phase.renewal,
      persistence: phase.persistence
    };
  }
  return {
    status: "ready",
    requestId: phase.record.requestId,
    accountId: phase.accountId,
    backendId: phase.backendId,
    expiresAt: phase.expiresAt,
    trustExpiresAt: phase.trustExpiresAt ?? null,
    remembered: phase.remembered,
    renewing: false,
    scopes: phase.scopes,
    workspace: phase.workspace,
    persistence: phase.persistence
  };
}

function commandMetadataFromEnvelope(envelope: BrowserWorkspaceCommandEnvelope): BrowserWorkspaceCommandMetadata {
  return {
    commandId: envelope.commandId,
    requestId: envelope.requestId,
    operation: envelope.operation,
    workspaceId: envelope.workspaceId,
    ...(envelope.repositoryId === undefined ? {} : { repositoryId: envelope.repositoryId }),
    expiresAt: envelope.expiresAt
  };
}

function publicCommandMetadata(command: TrackedCommand): BrowserWorkspaceCommandMetadata {
  return {
    commandId: command.commandId,
    requestId: command.requestId,
    operation: command.operation,
    workspaceId: command.workspaceId,
    ...(command.repositoryId === undefined ? {} : { repositoryId: command.repositoryId }),
    expiresAt: command.expiresAt
  };
}

function resultError(data: unknown): { code: string; message: string } | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const value = data as Record<string, unknown>;
  const error = value.error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) return undefined;
  const record = error as Record<string, unknown>;
  return typeof record.code === "string" && typeof record.message === "string"
    ? { code: record.code, message: record.message }
    : undefined;
}

async function openCommandResult<T>(
  trackedCommand: TrackedCommand,
  result: BrowserWorkspaceResultEnvelope,
  state: "completed" | "failed",
): Promise<BrowserWorkspaceExecution<T>> {
  let opened: unknown;
  try {
    opened = await openBrowserWorkspaceResult(
      trackedCommand.dsk,
      result,
      {
        backendId: trackedCommand.backendId,
        accountId: trackedCommand.accountId,
        requestId: trackedCommand.requestId,
        commandId: trackedCommand.commandId,
        operation: trackedCommand.operation,
        workspaceId: trackedCommand.workspaceId,
        ...(trackedCommand.repositoryId === undefined
          ? {}
          : { repositoryId: trackedCommand.repositoryId }),
        expiresAt: trackedCommand.expiresAt,
      },
    );
  } catch {
    throw new BrowserWorkspaceCommandError(
      trackedCommand.commandId,
      "The workspace result could not be authenticated.",
      true,
    );
  }
  const error = resultError(opened);
  return {
    ...publicCommandMetadata(trackedCommand),
    state,
    ok: state === "completed" && error === undefined,
    uncertain: false,
    data: opened as T,
    ...(error === undefined ? {} : { error }),
  };
}

function directCommandDispatch(value: unknown, commandId: string): DirectCommandDispatch | null {
  if (!isRecord(value) || value.commandId !== commandId) return null;
  const state = value.state;
  if (state !== "completed" && state !== "failed" && state !== "uncertain" && state !== "processing" && state !== "not-ready") {
    return null;
  }
  if (value.result !== undefined && !isRecord(value.result)) return null;
  return {
    commandId,
    state,
    ...(value.result === undefined ? {} : { result: value.result as unknown as BrowserWorkspaceResultEnvelope }),
  };
}

function wipeTrustMaterial(trust: BrowserWorkspaceTrustRecord | null): void {
  if (trust === null) return;
  trust.privateKey.fill(0);
  trust.proofKey.fill(0);
}

/**
 * Browser client for the Desktop-backed workspace. The DSK and private
 * browser scalar remain in this component instance. Results are returned to
 * the caller and are not cached in module state.
 */
export function useBrowserWorkspace(options: BrowserWorkspaceHookOptions) {
  const { accountScope, meshHosts = [], resumeStoredSession = true } = options;
  const store = useMemo(() => new BrowserWorkspaceKeyStore(), []);
  const [phase, setPhase] = useState<Phase>({ kind: "locked" });
  const phaseRef = useRef<Phase>({ kind: "locked" });
  const sessionGeneration = useRef(0);
  const tracked = useRef(new Map<string, TrackedCommand>());
  const polls = useRef(new Map<string, Promise<BrowserWorkspaceExecution>>());
  const statusPoll = useRef<Promise<void> | null>(null);
  const renewalRef = useRef<PendingPhase | null>(null);
  const [renewing, setRenewing] = useState(false);
  const ownerScope = useRef(accountScope);
  const [error, setError] = useState<string | null>(null);
  const [derivedCode, setDerivedCode] = useState<{ requestId: string; code: string }>();
  const directTransport = useRef<BrowserMachineWorkspaceTransport | null>(null);
  const [directStatus, setDirectStatus] = useState<BrowserWorkspaceDirectStatus>({
    state: "fallback",
    detail: "Using the hosted workspace relay while checking for a direct host route.",
  });
  const [directRetry, setDirectRetry] = useState(0);

  const replacePhase = useCallback((next: Phase, invalidateCommands = true) => {
    if (invalidateCommands) sessionGeneration.current += 1;
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const ownsCurrentScope = useCallback(
    (generation: number) => ownerScope.current === accountScope && sessionGeneration.current === generation,
    [accountScope]
  );

  const setRenewal = useCallback((pending: PendingPhase | null) => {
    renewalRef.current = pending;
    setRenewing(pending !== null);
  }, []);

  const dropTracked = useCallback((predicate: (command: TrackedCommand) => boolean) => {
    for (const [commandId, command] of tracked.current) {
      if (predicate(command)) {
        command.dsk.fill(0);
        tracked.current.delete(commandId);
      }
    }
  }, []);

  const endSession = useCallback(
    async (reason: NonNullable<BrowserWorkspaceAuth["reason"]>) => {
      const generation = sessionGeneration.current;
      if (!ownsCurrentScope(generation)) return;
      const current = phaseRef.current;
      const renewal = renewalRef.current;
      const requestIds = new Set<string>();
      const trustIds = new Set<string>();
      if (current.kind === "pending" || current.kind === "ready") {
        requestIds.add(current.record.requestId);
        if (current.record.trustId) trustIds.add(current.record.trustId);
        if (reason === "revoked" && current.record.trustId) {
          await store.removeTrust(accountScope, current.record.trustId);
        } else {
          await store.remove(accountScope, current.record.requestId);
        }
      }
      if (renewal !== null) {
        requestIds.add(renewal.record.requestId);
        if (renewal.record.trustId) trustIds.add(renewal.record.trustId);
        if (reason === "revoked" && renewal.record.trustId) {
          await store.removeTrust(accountScope, renewal.record.trustId);
        } else {
          await store.remove(accountScope, renewal.record.requestId);
        }
      }
      if (!ownsCurrentScope(generation)) return;
      if (current.kind === "pending" || current.kind === "ready") current.record.privateKey.fill(0);
      if (renewal !== null) renewal.record.privateKey.fill(0);
      setRenewal(null);
      dropTracked((command) => requestIds.has(command.requestId) || (command.trustId !== undefined && trustIds.has(command.trustId)));
      if (current.kind === "ready") current.dsk.fill(0);
      replacePhase({ kind: "ended", reason }, false);
    },
    [accountScope, dropTracked, ownsCurrentScope, replacePhase, setRenewal, store]
  );

  const lock = useCallback(async () => {
    const generation = sessionGeneration.current;
    if (!ownsCurrentScope(generation)) return;
    const current = phaseRef.current;
    const requestIds = new Set<string>();
    if (current.kind === "ready" || current.kind === "pending") {
      requestIds.add(current.record.requestId);
      current.record.privateKey.fill(0);
    }
    if (current.kind === "ready") current.dsk.fill(0);
    const renewal = renewalRef.current;
    if (renewal !== null) {
      requestIds.add(renewal.record.requestId);
      renewal.record.privateKey.fill(0);
    }
    for (const command of tracked.current.values()) command.dsk.fill(0);
    store.clearSessionMemory(accountScope);
    setRenewal(null);
    tracked.current.clear();
    replacePhase({ kind: "locked" });
    statusPoll.current = null;
    setError(null);
    for (const requestId of requestIds) await store.remove(accountScope, requestId);
  }, [accountScope, ownsCurrentScope, replacePhase, setRenewal, store]);

  const disconnect = useCallback(async (): Promise<void> => {
    const generation = sessionGeneration.current;
    if (!ownsCurrentScope(generation)) return;
    const current = phaseRef.current;
    const renewal = renewalRef.current;
    const record = current.kind === "pending" || current.kind === "ready"
      ? current.record
      : renewal?.record;
    if (record === undefined) {
      await lock();
      return;
    }
    try {
      const result = record.trustId
        ? await revokeBrowserWorkspaceTrustAction(record.trustId)
        : await revokeBrowserWorkspaceGrantAction(record.requestId);
      if (!result.ok) {
        if (ownsCurrentScope(generation)) setError(result.message);
        throw new Error(result.message);
      }
      if (record.trustId) await store.removeTrust(accountScope, record.trustId);
      else await store.remove(accountScope, record.requestId);
      if (!ownsCurrentScope(generation)) return;
      if (current.kind === "ready") {
        current.dsk.fill(0);
        current.record.privateKey.fill(0);
      } else if (current.kind === "pending") {
        current.record.privateKey.fill(0);
      }
      if (renewal !== null) renewal.record.privateKey.fill(0);
      const trustId = record.trustId;
      dropTracked((command) => command.requestId === record.requestId || (trustId !== undefined && command.trustId === trustId));
      setRenewal(null);
      replacePhase({ kind: "ended", reason: "revoked" }, false);
      setError(null);
    } catch (error) {
      // Do not erase local proof/key material until the server confirms revoke.
      if (ownsCurrentScope(generation) && error instanceof Error && !error.message.includes("Try again")) {
        setError(error.message);
      }
      throw error;
    }
  }, [accountScope, dropTracked, lock, ownsCurrentScope, replacePhase, setRenewal, store]);

  const acceptStatus = useCallback(
    async (pending: PendingPhase, status: HostedDashboardStatus) => {
      const { record } = pending;
      const generation = sessionGeneration.current;
      const isCurrent = () => ownsCurrentScope(generation);
      if (status.state === "denied" || status.state === "expired" || status.state === "revoked") {
        const isRenewalCurrent = renewalRef.current?.record.requestId === record.requestId;
        await store.remove(accountScope, record.requestId);
        if (status.state === "revoked" && record.trustId) {
          await store.removeTrust(accountScope, record.trustId);
        }
        if (!isCurrent()) return;
        if (isRenewalCurrent) setRenewal(null);
        const current = phaseRef.current;
        if (!isRenewalCurrent && current.kind === "pending" && current.record.requestId === record.requestId) {
          replacePhase({ kind: "ended", reason: status.state }, false);
        } else if (status.state === "revoked" && current.kind === "ready" && current.trustId === record.trustId) {
          replacePhase({ kind: "ended", reason: "revoked" }, false);
        }
        if (status.state === "revoked") {
          const targetTrust = record.trustId;
          dropTracked((command) => command.requestId === record.requestId || (targetTrust !== undefined && command.trustId === targetTrust));
          record.privateKey.fill(0);
          if (current.kind === "ready" && current.trustId === targetTrust) {
            current.dsk.fill(0);
            current.record.privateKey.fill(0);
          }
        } else {
          record.privateKey.fill(0);
        }
        if (status.state !== "expired") setError(status.state === "denied" ? "The Desktop declined workspace access." : "This browser connection was revoked.");
        return;
      }
      if (status.state !== "approved" || status.grant === undefined) return;
      if (
        typeof status.accountId !== "string" ||
        typeof status.backendId !== "string" ||
        status.grant.requestId !== record.requestId ||
        status.grant.browserPub !== record.browserPub ||
        status.grant.expiresAt !== record.expiresAt ||
        (status.expiresAt !== undefined && status.expiresAt !== record.expiresAt)
      ) {
        setError("The hosted service returned an unverifiable workspace grant.");
        return;
      }
      const inner = await unwrapDashboardGrant(
        record.privateKey,
        decodeBase64(record.browserPub),
        status.grant as DashboardGrantEnvelope,
        { backendId: status.backendId as string, accountId: status.accountId as string }
      );
      const isCurrentRequest = () =>
        renewalRef.current?.record.requestId === record.requestId ||
        (phaseRef.current.kind === "pending" && phaseRef.current.record.requestId === record.requestId);
      if (!isCurrent() || !isCurrentRequest()) return;
      if (inner === null) {
        setError("Could not open the sealed workspace grant. Request access again.");
        return;
      }
      const workspace = grantWorkspace(inner);
      const expiresAt = Date.parse(inner.expiresAt);
      const knownScopes: readonly DashboardScope[] = [
        "read-dashboard",
        "workspace-read",
        "workspace-write",
        "submit-task",
        "approve-action",
        "request-handoff",
        "terminal",
        "preview"
      ];
      const validScopes = Array.isArray(inner.scopes) && inner.scopes.every(
        (scope: unknown): scope is DashboardScope =>
          typeof scope === "string" && knownScopes.includes(scope as DashboardScope)
      );
      if (
        workspace === null ||
        !validScopes ||
        !Number.isFinite(expiresAt) ||
        inner.expiresAt !== record.expiresAt ||
        expiresAt <= Date.now() ||
        !inner.scopes.includes("workspace-read")
      ) {
        setError("The Desktop grant has no valid workspace-read binding.");
        return;
      }
      const scopes: DashboardScope[] = [...new Set(inner.scopes as DashboardScope[])];
      const origin = record.origin;
      const targetEnrollmentId = record.targetEnrollmentId;
      if (origin === undefined || targetEnrollmentId === undefined || workspace.enrollmentId !== targetEnrollmentId) {
        setError("The Desktop grant is bound to a different browser origin or machine.");
        return;
      }
      const bindings: BrowserWorkspaceBinding[] = [{
        workspaceId: workspace.workspaceId,
        repositoryIds: [...new Set(workspace.repoIds)].sort()
      }];
      if (
        bindings.length !== 1 ||
        bindings[0]?.workspaceId !== workspace.workspaceId ||
        JSON.stringify(bindings[0]?.repositoryIds) !== JSON.stringify([...workspace.repoIds].sort())
      ) {
        setError("The Desktop grant has an invalid workspace and repository binding.");
        return;
      }
      if (inner.browserTrust !== undefined && !isRecord(inner.browserTrust)) {
        setError("The Desktop returned invalid remembered-browser approval metadata.");
        return;
      }
      const trust = inner.browserTrust;
      let savedTrust: BrowserWorkspaceTrustRecord | null = null;
      let trustPersistence: BrowserWorkspacePersistence | null = null;
      if (record.trustId !== undefined) {
        const existing = await store.loadTrust(accountScope, record.trustId);
        if (!isCurrent() || !isCurrentRequest()) {
          wipeTrustMaterial(existing);
          return;
        }
        if (
          existing === null || trust === undefined || trust.trustId !== record.trustId ||
          trust.targetEnrollmentId !== targetEnrollmentId || trust.expiresAt !== existing.expiresAt ||
          existing.origin !== origin || existing.targetEnrollmentId !== targetEnrollmentId ||
          existing.accountId !== status.accountId || existing.browserPub !== record.browserPub ||
          JSON.stringify(existing.workspaceBindings) !== JSON.stringify(bindings) ||
          JSON.stringify([...existing.scopes].sort()) !== JSON.stringify([...scopes].sort()) ||
          trust.proofKey !== undefined
        ) {
          setError("The renewal grant does not match this browser's approved trust.");
          return;
        }
        savedTrust = existing;
        trustPersistence = await store.saveTrust(existing);
        if (!isCurrent() || !isCurrentRequest()) {
          wipeTrustMaterial(existing);
          return;
        }
        wipeTrustMaterial(existing);
      } else if (trust !== undefined) {
        let proofKey: Uint8Array = new Uint8Array(0);
        try {
          if (typeof trust.proofKey === "string") proofKey = new Uint8Array(decodeBase64(trust.proofKey));
        } catch {
          proofKey = new Uint8Array(0);
        }
        const trustExpiry = Date.parse(trust.expiresAt);
        if (
          !/^[A-Za-z0-9_-]{8,80}$/.test(trust.trustId) ||
          proofKey.byteLength !== 32 ||
          trust.targetEnrollmentId !== targetEnrollmentId ||
          !Number.isFinite(trustExpiry) || trustExpiry <= expiresAt ||
          trustExpiry > Date.now() + TRUST_HARD_MAX_MS + 60_000
        ) {
          setError("The Desktop returned invalid remembered-browser approval metadata.");
          return;
        }
        const approvedTrust: BrowserWorkspaceTrustRecord = {
          accountScope,
          accountId: status.accountId,
          trustId: trust.trustId,
          origin,
          targetEnrollmentId,
          browserPub: record.browserPub,
          privateKey: new Uint8Array(record.privateKey),
          proofKey,
          expiresAt: trust.expiresAt,
          workspaceBindings: bindings,
          scopes: [...scopes],
          createdAt: record.createdAt ?? new Date().toISOString()
        };
        savedTrust = approvedTrust;
        trustPersistence = await store.saveTrust(approvedTrust);
        if (!isCurrent() || !isCurrentRequest()) {
          wipeTrustMaterial(approvedTrust);
          return;
        }
        wipeTrustMaterial(approvedTrust);
      } else if (pending.renewal) {
        setError("The Desktop did not return the remembered browser trust for renewal.");
        return;
      }
      const trustedRecord: BrowserWorkspaceKeyRecord = {
        ...record,
        ...(savedTrust === null ? {} : { trustId: savedTrust.trustId })
      };
      const sessionPersistence = await store.save(trustedRecord);
      if (!isCurrent() || !isCurrentRequest()) {
        trustedRecord.privateKey.fill(0);
        return;
      }
      replacePhase({
        kind: "ready",
        record: trustedRecord,
        persistence: sessionPersistence,
        accountId: status.accountId,
        backendId: status.backendId,
        dsk: decodeDsk(inner),
        expiresAt: inner.expiresAt,
        scopes,
        workspace,
        ...(savedTrust === null ? {} : { trustId: savedTrust.trustId, trustExpiresAt: savedTrust.expiresAt }),
        remembered: trustPersistence === "indexeddb",
        origin
      }, false);
      if (renewalRef.current?.record.requestId === record.requestId) setRenewal(null);
      setError(null);
    },
    [accountScope, dropTracked, ownsCurrentScope, replacePhase, setRenewal, store]
  );

  const pollStatus = useCallback(async () => {
    const existing = statusPoll.current;
    if (existing !== null) return existing;
    const generation = sessionGeneration.current;
    const isCurrent = () => ownsCurrentScope(generation);
    const token: { promise?: Promise<void> } = {};
    const promise = (async () => {
      const current = phaseRef.current;
      const pending = renewalRef.current ?? (current.kind === "pending" ? current : null);
      if (pending === null && current.kind !== "ready") return;
      const record = pending?.record ?? (current.kind === "ready" ? current.record : null);
      if (record === null || record.accountScope !== accountScope) return;
      if (Date.parse(record.expiresAt) <= Date.now() && pending !== null) {
        await store.remove(accountScope, record.requestId);
        if (!isCurrent()) return;
        if (pending.renewal) setRenewal(null);
        else if (phaseRef.current.kind === "pending" && phaseRef.current.record.requestId === record.requestId) await endSession("expired");
        return;
      }
      const result = await (async () => {
        try {
          return await browserWorkspaceStatusAction(record.requestId);
        } catch {
          return { ok: false as const, code: "unavailable", message: "Workspace service unavailable." };
        }
      })();
      if (!result.ok) {
        if (isCurrent()) setError(result.message);
        return;
      }
      if (!isCurrent()) return;
      if (pending !== null) {
        await acceptStatus(pending, result.data);
      } else if (current.kind === "ready" && result.data.state === "revoked") {
        await endSession("revoked");
      } else if (current.kind === "ready" && result.data.state === "expired" && current.trustId === undefined) {
        await endSession("expired");
      }
    })().finally(() => {
      if (statusPoll.current === token.promise) statusPoll.current = null;
    });
    token.promise = promise;
    statusPoll.current = promise;
    return promise;
  }, [accountScope, acceptStatus, endSession, ownsCurrentScope, setRenewal, store]);

  const requestAccess = useCallback(
    async (request: BrowserWorkspaceRequestOptions): Promise<BrowserWorkspaceActionResult<HostedDashboardRequestResult>> => {
      const generation = sessionGeneration.current;
      const isCurrent = () => ownsCurrentScope(generation);
      const staleResult: BrowserWorkspaceActionResult<HostedDashboardRequestResult> = {
        ok: false,
        code: "scope-changed",
        message: "The signed-in account changed. Choose a Desktop machine again."
      };
      if (!isCurrent()) return staleResult;
      if (!isSafeId(request.targetEnrollmentId)) {
        setError("Choose a trusted Desktop machine.");
        return { ok: false, code: "invalid-scope", message: "Choose a trusted Desktop machine." };
      }
      if (typeof window === "undefined") {
        return { ok: false, code: "unavailable", message: "Open the workspace in a browser to connect." };
      }
      const origin = window.location.origin;
      const trust = await store.findTrust(accountScope, origin, request.targetEnrollmentId);
      if (!isCurrent()) {
        wipeTrustMaterial(trust);
        return staleResult;
      }
      const keypair = trust === null ? generateBrowserKeypair() : undefined;
      const expiresAt = new Date(Date.now() + REQUEST_TTL_MS).toISOString();
      const record: BrowserWorkspaceKeyRecord = {
        accountScope,
        requestId: randomRequestId(),
        browserPub: trust?.browserPub ?? encodeBase64(keypair!.pub),
        challenge: randomChallenge(),
        expiresAt,
        origin,
        targetEnrollmentId: request.targetEnrollmentId,
        ...(trust === null ? {} : { trustId: trust.trustId }),
        createdAt: new Date().toISOString(),
        privateKey: trust === null ? new Uint8Array(keypair!.priv) : new Uint8Array(trust.privateKey)
      };
      keypair?.priv.fill(0);
      const renewal = trust !== null;
      let renewalProof: string | undefined;
      try {
        if (trust !== null) {
          renewalProof = encodeBase64(await hmacSha256(
            trust.proofKey,
            dashboardRenewalProofMessage({
              accountId: trust.accountId,
              requestId: record.requestId,
              trustId: trust.trustId,
              browserPub: trust.browserPub,
              origin,
              targetEnrollmentId: trust.targetEnrollmentId,
              challenge: record.challenge,
              expiresAt,
              workspaceBindings: trust.workspaceBindings,
              scopes: trust.scopes
            })
          ));
        }
      } finally {
        wipeTrustMaterial(trust);
      }
      if (!isCurrent()) {
        record.privateKey.fill(0);
        return staleResult;
      }
      const persistence = await store.save(record);
      if (!isCurrent()) {
        await store.remove(accountScope, record.requestId);
        record.privateKey.fill(0);
        return staleResult;
      }
      const actionInput: BrowserWorkspaceAccessRequest = {
        requestId: record.requestId,
        targetEnrollmentId: request.targetEnrollmentId,
        browserPub: record.browserPub,
        challenge: record.challenge,
        ...(trust === null ? {} : { trustId: trust.trustId, renewalProof: renewalProof as string }),
        scopes: [],
        workspaceBindings: [],
        expiresAt
      };
      const previous = phaseRef.current;
      const pending: PendingPhase = { kind: "pending", record, persistence, renewal };
      const keepCurrent = renewal && previous.kind === "ready" && previous.trustId === trust?.trustId;
      if (keepCurrent) setRenewal(pending);
      else replacePhase(pending, false);
      const result = await requestBrowserWorkspaceAccessAction(actionInput);
      if (!isCurrent()) return staleResult;
      if (!result.ok) {
        await store.remove(accountScope, record.requestId);
        if (!isCurrent()) return staleResult;
        if (keepCurrent) setRenewal(null);
        else if (phaseRef.current.kind === "pending" && phaseRef.current.record.requestId === record.requestId) {
          replacePhase(previous, false);
        }
        setError(result.message);
        return { ok: false, code: result.code, message: result.message };
      }
      setError(null);
      return { ok: true, data: result.data };
    },
    [accountScope, ownsCurrentScope, replacePhase, setRenewal, store]
  );

  useEffect(() => {
    if (!resumeStoredSession || accountScope.length === 0) return;
    const generation = sessionGeneration.current;
    const isCurrent = () => ownsCurrentScope(generation);
    let cancelled = false;
    void store.list(accountScope).then(async (sessions) => {
      if (cancelled || !isCurrent() || phaseRef.current.kind !== "locked") {
        for (const session of sessions) session.record.privateKey.fill(0);
        return;
      }
      const live = sessions.filter((item) =>
        Date.parse(item.record.expiresAt) > Date.now() &&
        item.record.targetEnrollmentId !== undefined &&
        item.record.origin !== undefined
      );
      for (const session of sessions) {
        if (!live.includes(session)) {
          void store.remove(accountScope, session.record.requestId);
          session.record.privateKey.fill(0);
        }
      }
      const session = live
        .sort((a, b) => Date.parse(b.record.createdAt ?? "") - Date.parse(a.record.createdAt ?? ""))[0];
      if (session !== undefined) {
        if (cancelled || !isCurrent() || phaseRef.current.kind !== "locked") {
          for (const item of live) item.record.privateKey.fill(0);
          return;
        }
        for (const item of live) {
          if (item !== session) item.record.privateKey.fill(0);
        }
        const pending: PendingPhase = {
          kind: "pending",
          record: session.record,
          persistence: session.persistence,
          renewal: session.record.trustId !== undefined
        };
        if (pending.renewal) setRenewal(pending);
        replacePhase(pending, false);
        await pollStatus();
        return;
      }
      const origin = typeof window === "undefined" ? null : window.location.origin;
      if (origin === null) return;
      const allTrusts = await store.listTrusts(accountScope);
      const trusts = allTrusts
        .filter((trust) => trust.origin === origin && Date.parse(trust.expiresAt) > Date.now())
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      if (cancelled || !isCurrent()) {
        for (const trust of allTrusts) wipeTrustMaterial(trust);
        return;
      }
      const trust = trusts[0];
      const targetEnrollmentId = trust?.targetEnrollmentId;
      for (const candidate of allTrusts) wipeTrustMaterial(candidate);
      if (targetEnrollmentId !== undefined) {
        await requestAccess({ targetEnrollmentId });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [accountScope, ownsCurrentScope, pollStatus, replacePhase, requestAccess, resumeStoredSession, setRenewal, store]);

  useSynchronousBrowserEffect(() => {
    if (ownerScope.current === accountScope) return;
    const previousScope = ownerScope.current;
    ownerScope.current = accountScope;
    const current = phaseRef.current;
    const renewal = renewalRef.current;
    if (current.kind === "ready") current.dsk.fill(0);
    if (current.kind === "ready" || current.kind === "pending") current.record.privateKey.fill(0);
    if (renewal !== null) renewal.record.privateKey.fill(0);
    for (const command of tracked.current.values()) command.dsk.fill(0);
    tracked.current.clear();
    store.clearMemory(previousScope);
    statusPoll.current = null;
    setRenewal(null);
    setDerivedCode(undefined);
    setError(null);
    replacePhase({ kind: "locked" });
  }, [accountScope, replacePhase, setRenewal, store]);

  const directTargetEnrollmentId = phase.kind === "ready" ? phase.workspace.enrollmentId : null;
  const directHost = useMemo(
    () => meshHosts.find((host) => host.enrollmentId === directTargetEnrollmentId),
    [directTargetEnrollmentId, meshHosts],
  );
  const directRoutes = useMemo(() => browserMachineRouteCandidates(directHost), [directHost]);

  const subscribeMachineEvents = useCallback(
    (workspaceIds: readonly string[], handlers: BrowserMachineStreamHandlers) => {
      const transport = directTransport.current;
      if (!transport?.isOpen) return () => {};
      transport.subscribe([...workspaceIds], handlers);
      return () => transport.unsubscribe();
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | null = null;
    const scheduleRetry = () => {
      if (cancelled || retryTimer !== null) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        if (!cancelled) setDirectRetry((value) => value + 1);
      }, 15_000);
    };
    const previous = directTransport.current;
    directTransport.current = null;
    previous?.close();

    if (phase.kind !== "ready") {
      setDirectStatus({ state: "fallback", detail: "Authorize a Desktop workspace to enable direct host updates." });
      return () => { cancelled = true; };
    }
    if (directHost?.enrollmentId !== phase.workspace.enrollmentId || directRoutes.length === 0) {
      setDirectStatus({ state: "fallback", detail: "Direct host access is unavailable from this browser; using the hosted relay." });
      return () => { cancelled = true; };
    }

    const generation = sessionGeneration.current;
    setDirectStatus({ state: "connecting", detail: "Checking the approved Desktop’s direct host route." });
    void (async () => {
      for (const route of directRoutes) {
        if (cancelled || generation !== sessionGeneration.current) return;
        const dsk = new Uint8Array(phase.dsk);
        let transport: BrowserMachineWorkspaceTransport | null = null;
        try {
          transport = await BrowserMachineWorkspaceTransport.connect({
            route,
            accountId: phase.accountId,
            grantId: phase.record.requestId,
            targetEnrollmentId: phase.workspace.enrollmentId,
            workspaceId: phase.workspace.workspaceId,
            repositoryIds: phase.workspace.repoIds,
            scopes: phase.scopes,
            ...(phase.trustId === undefined ? {} : { trustId: phase.trustId }),
            dsk,
            origin: phase.origin,
            issueAdmissionTicket: async ({ clientPublicKey, bootstrapChallenge }) => {
              const result = await issueBrowserWorkspaceMachineAdmissionAction({
                machineId: route.machineId,
                endpointGeneration: route.endpointGeneration,
                clientPublicKey,
                bootstrapChallenge,
                grantId: phase.record.requestId,
              });
              if (!result.ok) {
                throw new BrowserMachineTransportError(
                  result.code,
                  "The workspace service could not authorize a direct host session.",
                );
              }
              return result.data;
            },
          });
          if (cancelled || generation !== sessionGeneration.current) {
            transport.close();
            return;
          }
          directTransport.current = transport;
          transport.setDisconnectedHandler(() => {
            if (cancelled || directTransport.current !== transport) return;
            directTransport.current = null;
            setDirectStatus({
              state: "fallback",
              detail: "The direct host connection closed; the hosted relay remains available and updates may be delayed.",
            });
            scheduleRetry();
          });
          setDirectStatus({ state: "live" });
          return;
        } catch {
          transport?.close();
        } finally {
          dsk.fill(0);
        }
      }
      if (!cancelled && generation === sessionGeneration.current) {
        setDirectStatus({
          state: "fallback",
          detail: "This browser cannot reach the approved Desktop directly; using the hosted relay.",
        });
        scheduleRetry();
      }
    })();

    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      const current = directTransport.current;
      directTransport.current = null;
      current?.close();
    };
  }, [directHost, directRetry, directRoutes, phase]);

  useEffect(() => {
    if (phase.kind !== "ready" || phase.trustId === undefined || phase.trustExpiresAt === undefined) return;
    let cancelled = false;
    let starting = false;
    const renewSoon = () => {
      if (cancelled || starting || renewalRef.current !== null) return;
      const sessionRemaining = Date.parse(phase.expiresAt) - Date.now();
      const trustRemaining = Date.parse(phase.trustExpiresAt!) - Date.now();
      if (trustRemaining <= 0 || sessionRemaining > TRUST_RENEWAL_WINDOW_MS) return;
      starting = true;
      void requestAccess({ targetEnrollmentId: phase.workspace.enrollmentId })
        .catch(() => undefined)
        .finally(() => { starting = false; });
    };
    renewSoon();
    const timer = window.setInterval(renewSoon, 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [phase, requestAccess]);

  useEffect(() => {
    if (phase.kind !== "pending") return;
    let cancelled = false;
    void dashboardVerificationCode(phase.record.browserPub, phase.record.challenge).then((code) => {
      if (!cancelled) setDerivedCode({ requestId: phase.record.requestId, code });
    });
    return () => {
      cancelled = true;
    };
  }, [phase]);

  useEffect(() => {
    if (phase.kind !== "pending" && phase.kind !== "ready") return;
    let cancelled = false;
    let running = false;
    const run = async () => {
      if (cancelled || running) return;
      running = true;
      try {
        await pollStatus();
      } finally {
        running = false;
      }
    };
    void run();
    const timer = window.setInterval(() => void run(), phase.kind === "pending" ? 5_000 : 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [phase.kind, pollStatus]);

  const pollCommand = useCallback(
    async <T = unknown>(commandId: string, timeoutMs = DEFAULT_POLL_TIMEOUT_MS): Promise<BrowserWorkspaceExecution<T>> => {
      const existing = polls.current.get(commandId);
      if (existing !== undefined) return existing as Promise<BrowserWorkspaceExecution<T>>;
      const trackedCommand = tracked.current.get(commandId);
      if (trackedCommand === undefined) {
        throw new BrowserWorkspaceCommandError(commandId, "This command is not available in the current browser session.", false);
      }
      const commandGeneration = trackedCommand.generation;
      const sessionIsCurrent = () =>
        sessionGeneration.current === commandGeneration &&
        tracked.current.get(commandId) === trackedCommand;
      const promise = (async (): Promise<BrowserWorkspaceExecution<T>> => {
        const deadline = Date.now() + timeoutMs;
        if (trackedCommand.transport === "machine") {
          const pending = await store.listPendingCommands(accountScope, trackedCommand.requestId);
          const saved = pending.find((item) => item.command.commandId === trackedCommand.commandId);
          if (saved === undefined) {
            return {
              ...publicCommandMetadata(trackedCommand),
              state: "unknown-outcome",
              ok: false,
              uncertain: true,
            };
          }
          let fallBackToHosted = false;
          while (Date.now() < deadline) {
            if (!sessionIsCurrent()) {
              throw new BrowserWorkspaceCommandError(
                commandId,
                "The browser workspace session ended while this command was running.",
                true,
              );
            }
            const transport = directTransport.current;
            if (!transport?.isOpen) {
              await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
              continue;
            }
            try {
              const response = await transport.request(
                trackedCommand.operation,
                saved.command,
                Math.max(1_000, Math.min(8_000, deadline - Date.now())),
              );
              const dispatch = directCommandDispatch(response.result, trackedCommand.commandId);
              if (dispatch === null) {
                return {
                  ...publicCommandMetadata(trackedCommand),
                  state: "unknown-outcome",
                  ok: false,
                  uncertain: true,
                  error: { code: "invalid-direct-result", message: "The Desktop returned an invalid command receipt." },
                };
              }
              if (dispatch.state === "completed" || dispatch.state === "failed") {
                if (dispatch.result === undefined) {
                  return {
                    ...publicCommandMetadata(trackedCommand),
                    state: "unknown-outcome",
                    ok: false,
                    uncertain: true,
                  };
                }
                const result = await openCommandResult<T>(trackedCommand, dispatch.result, dispatch.state);
                await store.removePendingCommand(accountScope, trackedCommand.requestId, trackedCommand.commandId);
                tracked.current.delete(commandId);
                return result;
              }
              if (dispatch.state === "not-ready") {
                // The host explicitly confirms it did not accept the command, so the
                // existing hosted submit path is safe to use with this same envelope.
                fallBackToHosted = true;
                break;
              }
            } catch (error) {
              if (error instanceof BrowserMachineTransportError && !error.sent) {
                // No frame reached the host. Hosted submit is safe for this command ID.
                fallBackToHosted = true;
                break;
              }
              // A sent frame can have executed even if its receipt was lost. Resubmit
              // the same sealed envelope over a direct session to hit the host receipt.
            }
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
          }
          if (!fallBackToHosted) {
            return {
              ...publicCommandMetadata(trackedCommand),
              state: "unknown-outcome",
              ok: false,
              uncertain: true,
            };
          }
          trackedCommand.transport = undefined;
          await store.savePendingCommand({ ...saved, transport: undefined });
          const hostedSubmit = await submitBrowserWorkspaceCommandAction(
            trackedCommand.requestId,
            saved.command,
          );
          if (!hostedSubmit.ok) {
            return {
              ...publicCommandMetadata(trackedCommand),
              state: "unknown-outcome",
              ok: false,
              uncertain: hostedSubmit.code === "unavailable" || hostedSubmit.code === "timeout",
              error: { code: hostedSubmit.code, message: hostedSubmit.message },
            };
          }
          if (hostedSubmit.data.state === "expired" || hostedSubmit.data.state === "revoked") {
            await store.removePendingCommand(accountScope, trackedCommand.requestId, trackedCommand.commandId);
            tracked.current.delete(commandId);
            return {
              ...publicCommandMetadata(trackedCommand),
              state: hostedSubmit.data.state,
              ok: false,
              uncertain: false,
            };
          }
        }
        for (;;) {
          if (!sessionIsCurrent()) {
            throw new BrowserWorkspaceCommandError(
              commandId,
              "The browser workspace session ended while this command was running.",
              true
            );
          }
          let status: Awaited<ReturnType<typeof browserWorkspaceCommandStatusAction>>;
          try {
            status = await browserWorkspaceCommandStatusAction(trackedCommand.requestId, commandId);
          } catch {
            throw new BrowserWorkspaceCommandError(
              commandId,
              "The workspace service could not report this command's outcome.",
              true
            );
          }
          if (!sessionIsCurrent()) {
            throw new BrowserWorkspaceCommandError(
              commandId,
              "The browser workspace session ended while this command was running.",
              true
            );
          }
          if (!status.ok) {
            throw new BrowserWorkspaceCommandError(commandId, status.message, status.code === "unavailable" || status.code === "timeout");
          }
          const data = status.data;
          if (
            data.requestId !== trackedCommand.requestId ||
            data.commandId !== trackedCommand.commandId ||
            data.operation !== trackedCommand.operation ||
            data.expiresAt !== trackedCommand.expiresAt
          ) {
            throw new BrowserWorkspaceCommandError(
              commandId,
              "The workspace service returned a command status for a different command.",
              true
            );
          }
          if (!TERMINAL_STATES.has(data.state)) {
            if (Date.now() >= deadline) {
              return { ...publicCommandMetadata(trackedCommand), state: "unknown-outcome", ok: false, uncertain: true };
            }
            await new Promise((resolve) => window.setTimeout(resolve, POLL_INTERVAL_MS));
            continue;
          }
          if (data.state !== "completed" && data.state !== "failed") {
            if (data.state === "expired" || data.state === "revoked") {
              void store.removePendingCommand(
                accountScope,
                trackedCommand.requestId,
                trackedCommand.commandId
              );
              tracked.current.delete(commandId);
            }
            return {
              ...publicCommandMetadata(trackedCommand),
              state: data.state,
              ok: false,
              uncertain: data.state === "unknown-outcome"
            };
          }
          if (data.result === undefined) {
            return { ...publicCommandMetadata(trackedCommand), state: "unknown-outcome", ok: false, uncertain: true };
          }
          let opened: unknown;
          try {
            opened = await openBrowserWorkspaceResult(
              trackedCommand.dsk,
              data.result as BrowserWorkspaceResultEnvelope,
              {
                backendId: trackedCommand.backendId,
                accountId: trackedCommand.accountId,
                requestId: trackedCommand.requestId,
                commandId: trackedCommand.commandId,
                operation: trackedCommand.operation,
                workspaceId: trackedCommand.workspaceId,
                ...(trackedCommand.repositoryId === undefined
                  ? {}
                  : { repositoryId: trackedCommand.repositoryId }),
                expiresAt: trackedCommand.expiresAt
              }
            );
          } catch {
            throw new BrowserWorkspaceCommandError(
              commandId,
              "The workspace result could not be authenticated.",
              true
            );
          }
          const error = resultError(opened);
          void store.removePendingCommand(
            accountScope,
            trackedCommand.requestId,
            trackedCommand.commandId
          );
          tracked.current.delete(commandId);
          return {
            ...publicCommandMetadata(trackedCommand),
            state: data.state,
            ok: data.state === "completed" && error === undefined,
            uncertain: false,
            data: opened as T,
            ...(error === undefined ? {} : { error })
          };
        }
      })().finally(() => {
        polls.current.delete(commandId);
      });
      polls.current.set(commandId, promise as Promise<BrowserWorkspaceExecution>);
      return promise;
    },
    [accountScope, store]
  );

  // Reconnect resumes status reads for commands whose encrypted envelope was
  // durably deposited before the previous page disappeared. It never submits
  // a command again, so an execution that already happened cannot be replayed.
  useEffect(() => {
    if (phase.kind !== "ready") return;
    const generation = sessionGeneration.current;
    let cancelled = false;
    void store.listPendingCommands(accountScope, phase.record.requestId).then((commands) => {
      if (cancelled || !ownsCurrentScope(generation) || phaseRef.current !== phase) return;
      const now = Date.now();
      for (const pending of commands) {
        if (Date.parse(pending.command.expiresAt) <= now) {
          void store.removePendingCommand(accountScope, pending.requestId, pending.command.commandId);
          continue;
        }
        const metadata = commandMetadataFromEnvelope(pending.command);
        if (tracked.current.size >= 64) break;
        tracked.current.set(pending.command.commandId, {
          ...metadata,
          dsk: phase.dsk,
          accountId: phase.accountId,
          backendId: phase.backendId,
          trustId: phase.trustId,
          generation,
          ...(pending.transport === "machine" ? { transport: "machine" as const } : {}),
        });
        void pollCommand(pending.command.commandId).catch(() => undefined);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [accountScope, ownsCurrentScope, phase, pollCommand, store]);

  const execute = useCallback(
    async <T = unknown>(input: BrowserWorkspaceCommandInput): Promise<BrowserWorkspaceExecution<T>> => {
      const current = phaseRef.current;
      if (current.kind !== "ready" || current.record.accountScope !== accountScope) {
        throw new BrowserWorkspaceCommandError("unissued", "Authorize a workspace before executing a command.", false);
      }
      const commandGeneration = sessionGeneration.current;
      const sessionIsCurrent = () =>
        sessionGeneration.current === commandGeneration && phaseRef.current === current;
      const commandStillTracked = () =>
        sessionGeneration.current === commandGeneration && tracked.current.has(commandId);
      if (Date.parse(current.expiresAt) <= Date.now()) {
        await endSession("expired");
        throw new BrowserWorkspaceCommandError("unissued", "The workspace grant expired.", false);
      }
      if (!isOperation(input.operation)) throw new BrowserWorkspaceCommandError("unissued", "Unsupported workspace operation.", false);
      const requiredScope = BROWSER_WORKSPACE_OPERATION_SCOPE[input.operation];
      if (!current.scopes.includes(requiredScope)) {
        throw new BrowserWorkspaceCommandError("unissued", `The grant does not include ${requiredScope}.`, false);
      }
      if (input.workspaceId !== current.workspace.workspaceId) {
        throw new BrowserWorkspaceCommandError("unissued", "The command workspace is outside the grant.", false);
      }
      if (input.repositoryId !== undefined && !current.workspace.repoIds.includes(input.repositoryId)) {
        throw new BrowserWorkspaceCommandError("unissued", "The command repository is outside the grant.", false);
      }
      if (tracked.current.size >= 64) {
        throw new BrowserWorkspaceCommandError(
          "unissued",
          "Too many pending browser workspace commands; wait for one to finish.",
          false
        );
      }
      const ttl = Math.max(1_000, Math.min(input.expiresInMs ?? COMMAND_TTL_MS, COMMAND_TTL_MS));
      const expiresAt = new Date(Math.min(Date.now() + ttl, Date.parse(current.expiresAt))).toISOString();
      const commandId = randomRequestId();
      const envelope = await sealBrowserWorkspaceCommand(current.dsk, {
        backendId: current.backendId,
        accountId: current.accountId,
        requestId: current.record.requestId,
        commandId,
        operation: input.operation,
        workspaceId: input.workspaceId,
        ...(input.repositoryId === undefined ? {} : { repositoryId: input.repositoryId }),
        expiresAt,
        payload: input.payload
      });
      if (!sessionIsCurrent()) {
        throw new BrowserWorkspaceCommandError(
          envelope.commandId,
          "The browser workspace session ended before this command was submitted.",
          false
        );
      }
      const metadata = commandMetadataFromEnvelope(envelope);
      const useDirectMachine = directTransport.current?.isOpen === true;
      try {
        await store.savePendingCommand({
          accountScope,
          requestId: current.record.requestId,
          command: envelope,
          createdAt: new Date().toISOString(),
          ...(useDirectMachine ? { transport: "machine" as const } : {}),
        });
      } catch (error) {
        throw new BrowserWorkspaceCommandError(
          commandId,
          error instanceof Error ? error.message : "Could not persist the encrypted command.",
          false
        );
      }
      if (!sessionIsCurrent()) {
        throw new BrowserWorkspaceCommandError(
          commandId,
          "The browser workspace session ended before this command was submitted.",
          false
        );
      }
      tracked.current.set(commandId, {
        ...metadata,
        dsk: current.dsk,
        accountId: current.accountId,
        backendId: current.backendId,
        generation: commandGeneration,
        ...(useDirectMachine ? { transport: "machine" as const } : {}),
        ...(current.trustId === undefined ? {} : { trustId: current.trustId })
      });
      if (useDirectMachine) return pollCommand<T>(commandId);
      const submitted = await submitBrowserWorkspaceCommandAction(current.record.requestId, envelope);
      if (!commandStillTracked()) {
        throw new BrowserWorkspaceCommandError(
          commandId,
          "The browser workspace session ended while this command was being submitted.",
          true
        );
      }
      if (!submitted.ok) {
        return { ...metadata, state: "unknown-outcome", ok: false, uncertain: submitted.code === "unavailable" || submitted.code === "timeout", error: { code: submitted.code, message: submitted.message } };
      }
      if (submitted.data.state === "expired" || submitted.data.state === "revoked" || submitted.data.state === "unknown-outcome") {
        if (submitted.data.state !== "unknown-outcome") {
          void store.removePendingCommand(accountScope, current.record.requestId, commandId);
        }
        return { ...metadata, state: submitted.data.state, ok: false, uncertain: submitted.data.state === "unknown-outcome" };
      }
      return pollCommand<T>(commandId);
    },
    [accountScope, endSession, pollCommand, store]
  );

  const phaseAccountScope = phase.kind === "pending" || phase.kind === "ready"
    ? phase.record.accountScope
    : accountScope;
  const auth = toAuth(phaseAccountScope === accountScope ? phase : { kind: "locked" });
  auth.renewing = renewing;
  if (auth.status === "pending" && derivedCode?.requestId === auth.requestId) {
    auth.verificationCode = derivedCode.code;
  }
  return {
    auth,
    error,
    requestAccess,
    execute,
    pollCommand,
    lock,
    refresh: pollStatus,
    disconnect,
    isReady: phase.kind === "ready" && phase.record.accountScope === accountScope && Date.parse(phase.expiresAt) > Date.now(),
    directStatus,
    subscribeMachineEvents,
  };
}

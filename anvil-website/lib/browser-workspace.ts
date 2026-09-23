"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  dashboardVerificationCode,
  decodeBase64,
  decodeDsk,
  encodeBase64,
  generateBrowserKeypair,
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
  submitBrowserWorkspaceCommandAction,
  type BrowserWorkspaceAccessRequest,
  type BrowserWorkspaceActionResult
} from "@/app/account/workspace/actions";
import {
  BROWSER_WORKSPACE_OPERATION_SCOPE,
  BROWSER_WORKSPACE_OPERATIONS,
  type BrowserWorkspaceCommandEnvelope,
  type BrowserWorkspaceOperation,
  type BrowserWorkspaceResultEnvelope,
  type DashboardCommandState,
  type DashboardScope,
  type HostedDashboardRequestResult,
  type HostedDashboardStatus
} from "@/lib/hosted/types";
import {
  BrowserWorkspaceKeyStore,
  type BrowserWorkspaceKeyRecord,
  type BrowserWorkspacePersistence
} from "@/lib/browser-workspace-auth";

const REQUEST_TTL_MS = 60 * 60_000;
const COMMAND_TTL_MS = 5 * 60_000;
// Keep command status reads bounded; each submitted command already consumes a
// retained coordinator row, so a tight read loop only adds load without
// changing the command outcome.
const POLL_INTERVAL_MS = 1_500;
const DEFAULT_POLL_TIMEOUT_MS = 30_000;

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
  workspaceIds: string[];
  repositoryIds?: string[];
  scopes?: DashboardScope[];
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
  /** Opt into polling for a stored pending request on initial render. */
  resumeStoredSession?: boolean;
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
}

const TERMINAL_STATES = new Set<DashboardCommandState>([
  "completed",
  "failed",
  "expired",
  "revoked",
  "unknown-outcome"
]);

function isOperation(value: string): value is BrowserWorkspaceOperation {
  return (BROWSER_WORKSPACE_OPERATIONS as readonly string[]).includes(value);
}

function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,200}$/.test(value);
}

function grantWorkspace(inner: DashboardGrantInner): BrowserWorkspaceWorkspaceGrant | null {
  const binding = inner.workspaceBindings?.[0];
  const workspace =
    binding === undefined && inner.workspace === undefined
      ? null
      : binding === undefined
        ? { workspaceId: inner.workspace!.workspaceId, repoIds: inner.workspace!.repoIds }
        : { workspaceId: binding.workspaceId, repoIds: binding.repositoryIds };
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
      persistence: phase.persistence
    };
  }
  return {
    status: "ready",
    requestId: phase.record.requestId,
    accountId: phase.accountId,
    backendId: phase.backendId,
    expiresAt: phase.expiresAt,
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

/**
 * Browser client for the Desktop-backed workspace. The DSK and private
 * browser scalar remain in this component instance. Results are returned to
 * the caller and are not cached in module state.
 */
export function useBrowserWorkspace(options: BrowserWorkspaceHookOptions) {
  const { accountScope, resumeStoredSession = true } = options;
  const store = useMemo(() => new BrowserWorkspaceKeyStore(), []);
  const [phase, setPhase] = useState<Phase>({ kind: "locked" });
  const phaseRef = useRef<Phase>({ kind: "locked" });
  const sessionGeneration = useRef(0);
  const tracked = useRef(new Map<string, TrackedCommand>());
  const polls = useRef(new Map<string, Promise<BrowserWorkspaceExecution>>());
  const statusPoll = useRef<Promise<void> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [derivedCode, setDerivedCode] = useState<{ requestId: string; code: string }>();

  const replacePhase = useCallback((next: Phase) => {
    sessionGeneration.current += 1;
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const endSession = useCallback(
    async (reason: NonNullable<BrowserWorkspaceAuth["reason"]>) => {
      const current = phaseRef.current;
      if (current.kind === "pending" || current.kind === "ready") {
        replacePhase({ kind: "ended", reason });
        tracked.current.clear();
        await store.clearAccount(accountScope);
        return;
      }
      tracked.current.clear();
      replacePhase({ kind: "ended", reason });
    },
    [accountScope, replacePhase, store]
  );

  const lock = useCallback(async () => {
    const current = phaseRef.current;
    if (current.kind === "pending" || current.kind === "ready") {
      replacePhase({ kind: "locked" });
      tracked.current.clear();
      await store.clearAccount(accountScope);
      setError(null);
      return;
    }
    tracked.current.clear();
    replacePhase({ kind: "locked" });
    setError(null);
  }, [accountScope, replacePhase, store]);

  const acceptStatus = useCallback(
    async (record: BrowserWorkspaceKeyRecord, persistence: BrowserWorkspacePersistence, status: HostedDashboardStatus) => {
      const generation = sessionGeneration.current;
      if (status.state === "denied" || status.state === "expired" || status.state === "revoked") {
        replacePhase({ kind: "ended", reason: status.state });
        tracked.current.clear();
        await store.clearAccount(accountScope);
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
      if (generation !== sessionGeneration.current || phaseRef.current.kind !== "pending") return;
      if (inner === null) {
        setError("Could not open the sealed workspace grant. Request access again.");
        return;
      }
      const workspace = grantWorkspace(inner);
      const expiresAt = Date.parse(inner.expiresAt);
      if (
        workspace === null ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= Date.now() ||
        !inner.scopes.includes("workspace-read")
      ) {
        setError("The Desktop grant has no valid workspace-read binding.");
        return;
      }
      const scopes = [...new Set(inner.scopes)].filter((scope): scope is DashboardScope =>
        [
          "workspace-read",
          "workspace-write",
          "submit-task",
          "approve-action",
          "request-handoff",
          "terminal",
          "preview"
        ].includes(scope)
      );
      replacePhase({
        kind: "ready",
        record,
        persistence,
        accountId: status.accountId,
        backendId: status.backendId,
        dsk: decodeDsk(inner),
        expiresAt: inner.expiresAt,
        scopes,
        workspace
      });
      setError(null);
    },
    [accountScope, replacePhase, store]
  );

  const pollStatus = useCallback(async () => {
    const existing = statusPoll.current;
    if (existing !== null) return existing;
    const promise = (async () => {
      const current = phaseRef.current;
      if (current.kind !== "pending" && current.kind !== "ready") return;
      const generation = sessionGeneration.current;
      const record = current.record;
      if (Date.parse(record.expiresAt) <= Date.now()) {
        await endSession("expired");
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
        setError(result.message);
        return;
      }
      if (generation !== sessionGeneration.current || phaseRef.current !== current) return;
      if (result.data.state === "revoked" || result.data.state === "expired" || result.data.state === "denied") {
        await endSession(result.data.state);
        return;
      }
      if (current.kind === "pending") {
        await acceptStatus(current.record, current.persistence, result.data);
      }
    })().finally(() => {
      statusPoll.current = null;
    });
    statusPoll.current = promise;
    return promise;
  }, [acceptStatus, endSession]);

  const requestAccess = useCallback(
    async (request: BrowserWorkspaceRequestOptions): Promise<BrowserWorkspaceActionResult<HostedDashboardRequestResult>> => {
      if (request.workspaceIds.length === 0) {
        setError("Choose a workspace before requesting access.");
        return { ok: false, code: "invalid-scope", message: "Choose a workspace before requesting access." };
      }
      const keypair = generateBrowserKeypair();
      const expiresAt = new Date(Date.now() + REQUEST_TTL_MS).toISOString();
      const record: BrowserWorkspaceKeyRecord = {
        accountScope,
        requestId: randomRequestId(),
        browserPub: encodeBase64(keypair.pub),
        challenge: randomChallenge(),
        expiresAt,
        createdAt: new Date().toISOString(),
        privateKey: new Uint8Array(keypair.priv)
      };
      const persistence = await store.save(record);
      const actionInput: BrowserWorkspaceAccessRequest = {
        requestId: record.requestId,
        browserPub: record.browserPub,
        challenge: record.challenge,
        workspaceIds: request.workspaceIds,
        ...(request.repositoryIds === undefined ? {} : { repositoryIds: request.repositoryIds }),
        ...(request.scopes === undefined ? {} : { scopes: request.scopes }),
        expiresAt,
        ...(typeof window === "undefined" ? {} : { origin: window.location.origin }),
        ...(typeof navigator === "undefined" ? {} : { userAgent: navigator.userAgent })
      };
      const result = await requestBrowserWorkspaceAccessAction(actionInput);
      if (!result.ok) {
        await store.remove(accountScope, record.requestId);
        setError(result.message);
        return { ok: false, code: result.code, message: result.message };
      }
      replacePhase({ kind: "pending", record, persistence });
      setError(null);
      return { ok: true, data: result.data };
    },
    [accountScope, replacePhase, store]
  );

  useEffect(() => {
    if (!resumeStoredSession || accountScope.length === 0) return;
    let cancelled = false;
    void store.list(accountScope).then(async (sessions) => {
      if (cancelled || sessions.length === 0 || phaseRef.current.kind !== "locked") return;
      const live = sessions.filter((item) => Date.parse(item.record.expiresAt) > Date.now());
      for (const session of sessions) {
        if (!live.includes(session)) void store.remove(accountScope, session.record.requestId);
      }
      const session = live
        .sort((a, b) => Date.parse(b.record.expiresAt) - Date.parse(a.record.expiresAt))[0];
      if (session === undefined) return;
      replacePhase({ kind: "pending", record: session.record, persistence: session.persistence });
      await pollStatus();
    });
    return () => {
      cancelled = true;
    };
  }, [accountScope, pollStatus, replacePhase, resumeStoredSession, store]);

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
        phaseRef.current.kind === "ready" &&
        tracked.current.get(commandId) === trackedCommand;
      const promise = (async (): Promise<BrowserWorkspaceExecution<T>> => {
        const deadline = Date.now() + timeoutMs;
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
      if (cancelled || generation !== sessionGeneration.current || phaseRef.current !== phase) return;
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
          generation
        });
        void pollCommand(pending.command.commandId).catch(() => undefined);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [accountScope, phase, pollCommand, store]);

  const execute = useCallback(
    async <T = unknown>(input: BrowserWorkspaceCommandInput): Promise<BrowserWorkspaceExecution<T>> => {
      const current = phaseRef.current;
      if (current.kind !== "ready") {
        throw new BrowserWorkspaceCommandError("unissued", "Authorize a workspace before executing a command.", false);
      }
      const commandGeneration = sessionGeneration.current;
      const sessionIsCurrent = () =>
        sessionGeneration.current === commandGeneration && phaseRef.current === current;
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
      try {
        await store.savePendingCommand({
          accountScope,
          requestId: current.record.requestId,
          command: envelope,
          createdAt: new Date().toISOString()
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
        generation: commandGeneration
      });
      const submitted = await submitBrowserWorkspaceCommandAction(current.record.requestId, envelope);
      if (!sessionIsCurrent()) {
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

  const auth = toAuth(phase);
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
    isReady: phase.kind === "ready"
  };
}

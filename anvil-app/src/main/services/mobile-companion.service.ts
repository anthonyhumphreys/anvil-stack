import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { BrowserWindow } from 'electron';
import QRCode from 'qrcode';
import type {
  CarPlayApprovalRequest,
  CarPlayDriveSnapshot,
  CarPlayNoteRequest,
  CarPlaySessionSummary,
  MobileChatThreadSummary,
  MobileCompanionAdvertisedAddress,
  MobileCompanionClientType,
  MobileCompanionDevice,
  MobileCompanionNotification,
  MobileCompanionStatus,
  MobileQuickAction,
  MobileOverview,
  MobilePairingPayload,
  MobilePairingTicket,
  MobileStartChatInput,
  MobileStartChatResult,
  MobileWorkQueueItem,
  MobileWorkflowDigest,
  RaycastCompanionToken,
} from '../../shared/types.js';
import {
  buildApprovalPolicy,
  isCarPlayActionAllowed,
  isCarPlayApprovable,
} from '../../shared/companion-policy.js';
import { getDb } from '../db/database.js';
import { getSettings } from './settings.service.js';
import { getWorkspace, listWorkspaces } from './workspace.service.js';
import { emitCompanionEvent, onCompanionEvent } from './companion-events.service.js';
import {
  getCodexSession,
  interruptTurn,
  listActiveCodexSessions,
  listPendingApprovalRequests,
  resolveApproval,
  sendMessage,
  startSession,
} from './codex-session.service.js';
import {
  createChatSession,
  createChatThread,
  deleteChatThread,
  getChatThread,
  loadChatHistory,
  saveChatEntry,
} from './chat-persistence.service.js';
import { createWorkspaceNote, listWorkspaceNotes } from './workspace-notes.service.js';

interface MobileCompanionSettingsRow {
  enabled: number;
  host: string;
  port: number;
  instance_id: string;
}

interface MobileCompanionDeviceRow {
  id: string;
  name: string;
  client_type?: MobileCompanionClientType;
  token_hash: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

interface ChatThreadRow {
  id: string;
  workspace_id: string | null;
  persona_id: string;
  title: string;
  updated_at: string;
  last_message_at: string | null;
  preview: string | null;
  message_count: number;
}

interface CompanionReviewItemRow {
  id: string;
  workspace_id: string | null;
  session_id: string | null;
  request_key: string | null;
  title: string;
  summary: string;
  requested_action: string;
  risk: CarPlayApprovalRequest['risk'];
  surface: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface PairingTicketState {
  ticket: string;
  expiresAt: string;
}

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 47631;
const PAIRING_TTL_MS = 5 * 60 * 1000;

const QUICK_ACTIONS: MobileQuickAction[] = [
  {
    id: 'status-sweep',
    title: 'Status sweep',
    subtitle: 'Summarise active work, blockers, approvals, and the next best move.',
    personaId: 'coder',
    tone: 'blue',
    requiresActiveWorkspace: true,
    prompt:
      'Give me a concise status sweep for this workspace. Cover active work, likely blockers, pending approvals, test/build risk, and the next best action. Be specific and avoid generic advice.',
  },
  {
    id: 'review-diff',
    title: 'Review current change',
    subtitle: 'Look for correctness, regressions, security, accessibility, and missing tests.',
    personaId: 'reviewer',
    tone: 'amber',
    requiresActiveWorkspace: true,
    prompt:
      'Review the current workspace changes. Prioritise correctness, regressions, security, data integrity, accessibility, and missing tests. Lead with findings and cite files where possible.',
  },
  {
    id: 'test-hunt',
    title: 'Find missing tests',
    subtitle: 'Identify the smallest useful test pass before this work ships.',
    personaId: 'coder',
    tone: 'green',
    requiresActiveWorkspace: true,
    prompt:
      'Find the most important missing tests for the current workspace changes. Suggest focused tests that would catch real regressions, and call out the narrowest useful commands to run.',
  },
  {
    id: 'ship-handoff',
    title: 'Ship handoff',
    subtitle: 'Create a tight handoff with changed behaviour, verification, and residual risk.',
    personaId: 'docs',
    tone: 'purple',
    requiresActiveWorkspace: true,
    prompt:
      'Prepare a tight engineering handoff for the current workspace. Include what changed, how to verify it, known risks, follow-ups, and any commands that should be run before shipping.',
  },
];

let server: Server | null = null;
let serverRunning = false;
let serverError: string | null = null;
const pairingTickets = new Map<string, PairingTicketState>();
const recentNotifications: MobileCompanionNotification[] = [];

export async function getMobileCompanionStatus(): Promise<MobileCompanionStatus> {
  const settings = ensureMobileCompanionSettings();
  return buildStatus(settings);
}

export async function setMobileCompanionEnabled(enabled: boolean): Promise<MobileCompanionStatus> {
  ensureMobileCompanionSettings();
  getDb()
    .prepare(
      `UPDATE mobile_companion_settings
       SET enabled = ?, updated_at = ?
       WHERE id = 1`,
    )
    .run(enabled ? 1 : 0, new Date().toISOString());

  if (enabled) {
    await startMobileCompanionServer();
  } else {
    await stopMobileCompanionServer();
  }

  emitCompanionEvent('settings');
  return getMobileCompanionStatus();
}

export async function syncMobileCompanionServer(): Promise<void> {
  const settings = ensureMobileCompanionSettings();
  if (settings.enabled) {
    await startMobileCompanionServer();
  } else {
    await stopMobileCompanionServer();
  }
}

export async function startMobileCompanionServer(): Promise<void> {
  const settings = ensureMobileCompanionSettings();
  if (server) return;

  serverError = null;
  server = createServer((req, res) => {
    void handleRequest(req, res).catch((err) => {
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : 'Mobile companion request failed',
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server?.once('error', (err) => {
      serverError = err.message;
      server = null;
      serverRunning = false;
      reject(err);
    });
    server?.listen(settings.port, settings.host, () => {
      serverRunning = true;
      resolve();
    });
  });
}

export async function stopMobileCompanionServer(): Promise<void> {
  if (!server) {
    serverRunning = false;
    return;
  }

  const closing = server;
  server = null;
  await new Promise<void>((resolve) => {
    closing.close(() => resolve());
  });
  serverRunning = false;
}

export async function createMobilePairingTicket(): Promise<MobilePairingTicket> {
  const settings = ensureMobileCompanionSettings();
  if (!settings.enabled || !serverRunning) {
    await setMobileCompanionEnabled(true);
  }

  const latestSettings = ensureMobileCompanionSettings();
  const baseUrl = selectPairingBaseUrl(latestSettings);
  const ticket = randomToken(18);
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
  pairingTickets.set(ticket, { ticket, expiresAt });

  const payload: MobilePairingPayload = {
    app: 'anvil',
    version: 1,
    instanceId: latestSettings.instance_id,
    baseUrl,
    ticket,
    expiresAt,
  };
  const pairingUrl = JSON.stringify(payload);
  const qrSvg = await QRCode.toString(pairingUrl, {
    type: 'svg',
    margin: 1,
    color: {
      dark: '#111827',
      light: '#ffffff',
    },
  });

  return { ticket, expiresAt, pairingUrl, qrSvg };
}

export async function createRaycastCompanionToken(): Promise<RaycastCompanionToken> {
  const settings = ensureMobileCompanionSettings();
  if (!settings.enabled || !serverRunning) {
    await setMobileCompanionEnabled(true);
  }

  const latestSettings = ensureMobileCompanionSettings();
  const token = randomToken(32);
  const now = new Date().toISOString();
  const device = createCompanionDevice('Raycast', 'raycast', token, now);
  emitCompanionEvent('settings');

  return {
    baseUrl: selectPairingBaseUrl(latestSettings),
    token,
    device,
  };
}

export function listMobileCompanionDevices(): MobileCompanionDevice[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM mobile_companion_devices
       ORDER BY created_at DESC`,
    )
    .all() as MobileCompanionDeviceRow[];
  return rows.map(mapDevice);
}

export function revokeMobileCompanionDevice(deviceId: string): void {
  getDb()
    .prepare(
      `UPDATE mobile_companion_devices
       SET revoked_at = COALESCE(revoked_at, ?)
       WHERE id = ?`,
    )
    .run(new Date().toISOString(), deviceId);
}

export function listMobileQuickActions(): MobileQuickAction[] {
  return QUICK_ACTIONS;
}

function ensureMobileCompanionSettings(): MobileCompanionSettingsRow {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO mobile_companion_settings
     (id, enabled, host, port, instance_id, updated_at)
     VALUES (1, 0, ?, ?, ?, ?)`,
  ).run(DEFAULT_HOST, DEFAULT_PORT, randomUUID(), new Date().toISOString());

  return db
    .prepare('SELECT enabled, host, port, instance_id FROM mobile_companion_settings WHERE id = 1')
    .get() as MobileCompanionSettingsRow;
}

function buildStatus(settings: MobileCompanionSettingsRow): MobileCompanionStatus {
  const advertisedAddresses = getAdvertisedAddresses(settings.port);
  const baseUrl = settings.enabled ? selectPairingBaseUrl(settings) : null;
  const pairedDeviceCount = getPairedDeviceCount();

  return {
    enabled: Boolean(settings.enabled),
    running: serverRunning,
    host: settings.host,
    port: settings.port,
    baseUrl,
    advertisedAddresses,
    pairedDeviceCount,
  };
}

function getPairedDeviceCount(): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS count
       FROM mobile_companion_devices
       WHERE revoked_at IS NULL`,
    )
    .get() as { count: number };
  return row.count;
}

function selectPairingBaseUrl(settings: MobileCompanionSettingsRow): string {
  const addresses = getAdvertisedAddresses(settings.port);
  return (
    addresses.find((address) => address.kind === 'tailscale')?.url ??
    addresses.find((address) => address.kind === 'lan')?.url ??
    `http://127.0.0.1:${settings.port}`
  );
}

function getAdvertisedAddresses(port: number): MobileCompanionAdvertisedAddress[] {
  const addresses: MobileCompanionAdvertisedAddress[] = [];

  for (const [name, interfaces] of Object.entries(networkInterfaces())) {
    for (const item of interfaces ?? []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      const kind = item.address.startsWith('100.') ? 'tailscale' : 'lan';
      addresses.push({
        label: `${kind === 'tailscale' ? 'Tailscale' : 'LAN'} · ${name}`,
        url: `http://${item.address}:${port}`,
        kind,
      });
    }
  }

  addresses.push({
    label: 'This Mac',
    url: `http://127.0.0.1:${port}`,
    kind: 'loopback',
  });

  return addresses;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  setCommonHeaders(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathParts = url.pathname.split('/').filter(Boolean);

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true, status: await getMobileCompanionStatus(), error: serverError });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/pair') {
    const body = await readJsonBody<{ ticket?: string; deviceName?: string }>(req);
    pairDevice(res, body.ticket, body.deviceName);
    return;
  }

  const device = authenticateRequest(req, req.method === 'GET' && url.pathname === '/api/events');
  if (!device) {
    sendJson(res, 401, { error: 'Missing or invalid mobile companion token.' });
    return;
  }

  touchDevice(device.id);

  if (req.method === 'GET' && url.pathname === '/api/overview') {
    sendJson(res, 200, getMobileOverview());
    return;
  }

  if (pathParts[0] === 'api' && pathParts[1] === 'carplay') {
    await handleCarPlayRequest(req, res, pathParts);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/chat/threads') {
    sendJson(res, 200, listMobileChatThreads());
    return;
  }

  if (req.method === 'GET' && pathParts[0] === 'api' && pathParts[1] === 'chat') {
    const threadId = pathParts[3];
    if (pathParts[2] === 'threads' && threadId && pathParts[4] === 'history') {
      sendJson(res, 200, loadChatHistory(threadId));
      return;
    }
  }

  if (req.method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'chat') {
    const threadId = pathParts[3];
    if (pathParts[2] === 'threads' && threadId && pathParts[4] === 'messages') {
      const body = await readJsonBody<{ sessionId?: string; message?: string }>(req);
      await sendMobileMessage(threadId, body.sessionId, body.message);
      sendJson(res, 202, { ok: true });
      return;
    }

    if (pathParts[2] === 'start') {
      const body = await readJsonBody<MobileStartChatInput>(req);
      sendJson(res, 201, await startMobileWorkflow(body));
      return;
    }
  }

  if (req.method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'approvals') {
    const sessionId = pathParts[2];
    const requestKey = pathParts[3];
    if (sessionId && requestKey && pathParts[4] === 'resolve') {
      const body = await readJsonBody<{
        decision?: 'accept' | 'acceptForSession' | 'decline' | 'cancel';
      }>(req);
      resolveMobileApproval(sessionId, requestKey, body.decision);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  if (req.method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'sessions') {
    const sessionId = pathParts[2];
    if (sessionId && pathParts[3] === 'interrupt') {
      interruptTurn(sessionId);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/desktop/open') {
    focusDesktop();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    writeEventStream(res);
    return;
  }

  sendJson(res, 404, { error: 'Mobile companion endpoint not found.' });
}

async function handleCarPlayRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathParts: string[],
): Promise<void> {
  if (req.method === 'GET' && pathParts.length === 2) {
    sendJson(res, 200, getCarPlayDriveSnapshot());
    return;
  }

  if (req.method === 'GET' && pathParts[2] === 'approvals') {
    const approval = findCarPlayApproval(pathParts[3]);
    if (!approval) {
      sendJson(res, 404, { error: 'CarPlay approval not found.' });
      return;
    }
    sendJson(res, 200, approval);
    return;
  }

  if (req.method === 'POST' && pathParts[2] === 'sessions') {
    const sessionId = pathParts[3];
    if (sessionId && pathParts[4] === 'pause') {
      interruptTurn(sessionId);
      pushCompanionNotification(
        'sessions',
        'Paused',
        'The session was paused from Anvil Drive.',
        'carplay',
      );
      emitCompanionEvent('sessions');
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathParts[3] === 'pause-all') {
      for (const session of listActiveCodexSessions()) {
        interruptTurn(session.id);
      }
      pushCompanionNotification(
        'sessions',
        'Paused',
        'All active sessions were paused from Anvil Drive.',
        'carplay',
      );
      emitCompanionEvent('sessions');
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  if (req.method === 'POST' && pathParts[2] === 'approvals') {
    const approvalIdParam = pathParts[3];
    const action = pathParts[4];
    const approval = findCarPlayApproval(approvalIdParam);
    if (!approval) {
      sendJson(res, 404, { error: 'CarPlay approval not found.' });
      return;
    }

    if (action === 'approve') {
      try {
        approveCarPlayApproval(approval);
      } catch (err) {
        sendJson(res, 403, {
          error: err instanceof Error ? err.message : 'Requires desktop review',
        });
        return;
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (action === 'decline') {
      resolveMobileApproval(approval.sessionId, approval.requestKey, 'decline');
      pushCompanionNotification(
        'approvals',
        'Declined',
        'The approval was declined from Anvil Drive.',
        'carplay',
      );
      sendJson(res, 200, { ok: true });
      return;
    }

    if (action === 'later') {
      markCarPlayApprovalForLater(approval);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  if (req.method === 'POST' && pathParts[2] === 'notes') {
    const body = await readJsonBody<CarPlayNoteRequest>(req);
    const note = createWorkspaceNote({
      workspaceId: body.workspaceId ?? getSettings().activeWorkspaceId ?? undefined,
      repo: body.repo,
      body: body.body,
      source: body.source === 'siri' ? 'siri' : 'carplay',
    });
    pushCompanionNotification(
      'notes',
      'Captured note',
      'A workspace note is ready for desktop review.',
      note.source,
    );
    sendJson(res, 201, note);
    return;
  }

  if (req.method === 'POST' && pathParts[2] === 'handover') {
    const body = await readJsonBody<{ workspaceId?: string }>(req);
    const result = await startMobileWorkflow({
      actionId: 'ship-handoff',
      workspaceId: body.workspaceId ?? getSettings().activeWorkspaceId ?? undefined,
    });
    pushCompanionNotification(
      'handover',
      'Handover started',
      'Anvil is preparing a desktop handover.',
      'carplay',
    );
    emitCompanionEvent('handover');
    sendJson(res, 202, result);
    return;
  }

  sendJson(res, 404, { error: 'CarPlay companion endpoint not found.' });
}

function pairDevice(
  res: ServerResponse,
  ticket: string | undefined,
  deviceName: string | undefined,
): void {
  if (!ticket) {
    sendJson(res, 400, { error: 'Pairing ticket is required.' });
    return;
  }

  const state = pairingTickets.get(ticket);
  if (!state) {
    sendJson(res, 401, { error: 'Pairing ticket is invalid or already used.' });
    return;
  }

  pairingTickets.delete(ticket);
  if (new Date(state.expiresAt).getTime() < Date.now()) {
    sendJson(res, 401, { error: 'Pairing ticket has expired.' });
    return;
  }

  const token = randomToken(32);
  const now = new Date().toISOString();
  const device = createCompanionDevice(
    deviceName?.trim() || 'Mobile companion',
    'mobile',
    token,
    now,
  );
  emitCompanionEvent('settings');

  sendJson(res, 200, {
    token,
    device,
  });
}

function createCompanionDevice(
  name: string,
  clientType: MobileCompanionClientType,
  token: string,
  now: string,
): MobileCompanionDevice {
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO mobile_companion_devices
       (id, name, client_type, token_hash, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, name, clientType, hashToken(token), now, now);

  return {
    id,
    name,
    clientType,
    createdAt: now,
    lastSeenAt: now,
  };
}

function authenticateRequest(
  req: IncomingMessage,
  allowQueryToken = false,
): MobileCompanionDeviceRow | null {
  const header = req.headers.authorization;
  const eventStreamToken = allowQueryToken
    ? new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('access_token')
    : null;
  const token = header?.startsWith('Bearer ')
    ? header.slice('Bearer '.length).trim()
    : eventStreamToken?.trim();
  if (!token) return null;
  const tokenHash = hashToken(token);
  const row = getDb()
    .prepare(
      `SELECT * FROM mobile_companion_devices
       WHERE token_hash = ? AND revoked_at IS NULL`,
    )
    .get(tokenHash) as MobileCompanionDeviceRow | undefined;
  return row ?? null;
}

function touchDevice(deviceId: string): void {
  getDb()
    .prepare('UPDATE mobile_companion_devices SET last_seen_at = ? WHERE id = ?')
    .run(new Date().toISOString(), deviceId);
}

export function getMobileOverview(): MobileOverview {
  const settings = getSettings();
  const workspaces = listWorkspaces();
  const activeWorkspace = settings.activeWorkspaceId
    ? safeGetWorkspace(settings.activeWorkspaceId)
    : undefined;
  const activeSessions = listActiveCodexSessions();
  const pendingApprovals = enrichMobileApprovalRequests(
    listPendingApprovalRequests(),
    activeWorkspace,
    activeSessions,
  );
  const threads = listMobileChatThreads();

  return {
    generatedAt: new Date().toISOString(),
    activeWorkspace,
    workspaces,
    activeSessions,
    pendingApprovals,
    threads,
    workQueue: buildMobileWorkQueue(activeWorkspace, activeSessions, pendingApprovals, threads),
    workflow: buildWorkflowDigest(activeWorkspace, activeSessions, pendingApprovals, threads),
    quickActions: listMobileQuickActions(),
    companion: buildStatus(ensureMobileCompanionSettings()),
    notifications: listRecentCompanionNotifications(),
  };
}

export function getCarPlayDriveSnapshot(): CarPlayDriveSnapshot {
  const overview = getMobileOverview();
  const approvals = listCarPlayApprovalRequests();
  const sessions = listCarPlaySessions();
  const requiresDesktopReview = approvals.filter((approval) => !approval.carPlayApprovable).length;

  return {
    generatedAt: new Date().toISOString(),
    title: 'Anvil Drive',
    attention: {
      pendingApprovals: approvals.length,
      blockedSessions: approvals.length,
      requiresDesktopReview,
      failedChecks: overview.activeSessions.filter((session) => session.status === 'error').length,
    },
    sessions,
    approvals,
    recentNotes: listWorkspaceNotes(overview.activeWorkspace?.id).slice(0, 5),
    safeActions: [
      { id: 'pause-all', label: 'Pause all', enabled: sessions.length > 0 },
      {
        id: 'continue-low-risk-checks',
        label: 'Continue checks',
        enabled: approvals.some((approval) => approval.carPlayApprovable),
      },
      {
        id: 'prepare-handover',
        label: 'Prepare handover',
        enabled: Boolean(overview.activeWorkspace),
      },
      {
        id: 'mark-everything-later',
        label: 'Review later',
        enabled: approvals.length > 0,
      },
      { id: 'capture-note', label: 'Capture note', enabled: Boolean(overview.activeWorkspace) },
    ],
  };
}

export function listCarPlayApprovalRequests(): CarPlayApprovalRequest[] {
  const overview = getMobileOverview();
  const markedLater = new Set(
    listCompanionReviewItems()
      .filter((item) => item.status === 'later')
      .map((item) => `${item.session_id}:${item.request_key}`),
  );

  return overview.pendingApprovals.map((approval) => {
    const policy = buildApprovalPolicy(approval);
    const session = overview.activeSessions.find(
      (candidate) => candidate.id === approval.sessionId,
    );
    const workspace =
      session?.workspaceId && overview.activeWorkspace?.id === session.workspaceId
        ? overview.activeWorkspace
        : overview.activeWorkspace;
    const repo = session?.repoId
      ? workspace?.repos.find((candidate) => candidate.id === session.repoId)
      : undefined;
    const id = approvalId(approval.sessionId, approval.requestKey);

    return {
      ...approval,
      id,
      title: approval.kind === 'command' ? 'Command approval' : 'File change approval',
      workspaceId: workspace?.id,
      workspaceName: workspace?.name,
      repo: repo?.name ?? repo?.path ?? approval.repoName,
      summary: policy.summary,
      requestedAction: policy.requestedAction,
      risk: policy.risk,
      requiresFullReview: policy.requiresFullReview,
      allowedSurfaces: policy.allowedSurfaces,
      carPlayApprovable: isCarPlayApprovable(policy),
      blockedReason: policy.blockedReason,
      markedForLater: markedLater.has(`${approval.sessionId}:${approval.requestKey}`),
    };
  });
}

export function listCarPlaySessions(): CarPlaySessionSummary[] {
  const overview = getMobileOverview();

  return overview.activeSessions.map((session) => {
    const thread = overview.threads.find((candidate) => candidate.activeSessionId === session.id);
    const workspace =
      session.workspaceId && overview.activeWorkspace?.id === session.workspaceId
        ? overview.activeWorkspace
        : overview.activeWorkspace;
    const repo = session.repoId
      ? workspace?.repos.find((candidate) => candidate.id === session.repoId)
      : undefined;
    const pendingApprovalCount = overview.pendingApprovals.filter(
      (approval) => approval.sessionId === session.id,
    ).length;

    return {
      id: session.id,
      workspaceId: workspace?.id,
      workspaceName: workspace?.name,
      repo: repo?.name ?? repo?.path,
      title: thread?.title ?? `${session.personaId} session`,
      status:
        pendingApprovalCount > 0 ? 'blocked' : session.status === 'busy' ? 'active' : 'paused',
      summary:
        pendingApprovalCount > 0
          ? `${pendingApprovalCount} approval${pendingApprovalCount === 1 ? '' : 's'} waiting.`
          : session.status === 'busy'
            ? 'Agent is working.'
            : 'Agent is waiting.',
      updatedAt: thread?.updatedAt ?? session.startedAt,
    };
  });
}

function listMobileChatThreads(): MobileChatThreadSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT
        t.id,
        t.workspace_id,
        t.persona_id,
        t.title,
        t.updated_at,
        t.last_message_at,
        (
          SELECT m.content
          FROM chat_messages m
          WHERE m.thread_id = t.id
          ORDER BY m.timestamp DESC
          LIMIT 1
        ) AS preview,
        (
          SELECT COUNT(*)
          FROM chat_messages m
          WHERE m.thread_id = t.id AND m.role IN ('user', 'assistant')
        ) AS message_count
       FROM chat_threads t
       ORDER BY COALESCE(t.last_message_at, t.updated_at) DESC
       LIMIT 40`,
    )
    .all() as ChatThreadRow[];

  const sessions = listActiveCodexSessions();
  const approvals = listPendingApprovalRequests();

  return rows.map((row) => {
    const activeSession = sessions.find((session) => session.appThreadId === row.id);
    return {
      id: row.id,
      personaId: row.persona_id,
      title: row.title,
      workspaceId: row.workspace_id ?? undefined,
      preview: row.preview ?? undefined,
      messageCount: row.message_count,
      updatedAt: row.last_message_at ?? row.updated_at,
      activeSessionId: activeSession?.id,
      activeSessionStatus: activeSession?.status,
      pendingApprovalCount: activeSession
        ? approvals.filter((approval) => approval.sessionId === activeSession.id).length
        : 0,
    };
  });
}

async function sendMobileMessage(
  threadId: string,
  sessionId: string | undefined,
  message: string | undefined,
): Promise<void> {
  if (!message?.trim()) throw new Error('Message is required.');
  const targetSessionId =
    sessionId ?? listMobileChatThreads().find((thread) => thread.id === threadId)?.activeSessionId;
  if (!targetSessionId || !getCodexSession(targetSessionId)) {
    throw new Error('This thread does not have an active desktop Codex session.');
  }
  const session = getCodexSession(targetSessionId);
  const thread = getChatThread(threadId);
  const timestamp = new Date().toISOString();
  saveChatEntry(threadId, session?.repoId ?? null, targetSessionId, {
    id: randomUUID(),
    role: 'user',
    content: message.trim(),
    timestamp,
    personaId: session?.personaId ?? thread?.personaId,
    sessionId: targetSessionId,
    threadId,
  });
  await sendMessage(targetSessionId, message.trim());
  pushCompanionNotification(
    'sessions',
    'Session updated',
    'A companion message was sent to an active session.',
    'mobile',
  );
  emitCompanionEvent('sessions');
}

export async function startMobileWorkflow(
  input: MobileStartChatInput,
): Promise<MobileStartChatResult> {
  const action = input.actionId
    ? QUICK_ACTIONS.find((candidate) => candidate.id === input.actionId)
    : undefined;
  if (input.actionId && !action) {
    throw new Error(`Unknown companion quick action: ${input.actionId}`);
  }

  const message = input.message?.trim() || action?.prompt;
  if (!message) throw new Error('Message is required.');

  const activeWorkspaceId = getSettings().activeWorkspaceId;
  const targetWorkspaceId = input.workspaceId ?? activeWorkspaceId;
  const workspace = targetWorkspaceId ? safeGetWorkspace(targetWorkspaceId) : undefined;

  if (action?.requiresActiveWorkspace && !workspace) {
    throw new Error('Select an active workspace in the desktop app before launching this action.');
  }

  const workspaceRepoIds = workspace?.repos.map((repo) => repo.id) ?? [];
  const repoIds = input.repoIds?.length ? input.repoIds : workspaceRepoIds;
  const repoPaths = repoIds
    .map((repoId) => workspace?.repos.find((repo) => repo.id === repoId)?.path)
    .filter((repoPath): repoPath is string => Boolean(repoPath));

  if (repoIds.length === 0 || repoPaths.length === 0) {
    throw new Error(
      'Add at least one repo to the active workspace before launching Codex remotely.',
    );
  }

  const personaId = input.personaId?.trim() || action?.personaId || 'coder';
  const title = input.title?.trim() || action?.title || titleFromMessage(message);
  const thread = createChatThread({
    workspaceId: workspace?.id ?? null,
    personaId,
    title,
    repoIds,
    activeRepoId: repoIds[0] ?? null,
  });
  let session: Awaited<ReturnType<typeof startSession>>;
  try {
    session = await startSession(repoPaths, repoIds, personaId, {
      threadId: thread.id,
      workspace: workspace ? { workspaceId: workspace.id } : undefined,
    });
  } catch (err) {
    deleteChatThread(thread.id);
    throw err;
  }

  createChatSession(thread.id, repoIds[0] ?? null, personaId, session.id);
  const timestamp = new Date().toISOString();
  saveChatEntry(thread.id, repoIds[0] ?? null, session.id, {
    id: randomUUID(),
    role: 'user',
    content: message,
    timestamp,
    personaId,
    sessionId: session.id,
    threadId: thread.id,
  });
  await sendMessage(session.id, message, [], { collaborationMode: input.collaborationMode });
  pushCompanionNotification(
    'sessions',
    'Workflow started',
    `${title} is running on the desktop host.`,
    'mobile',
  );
  emitCompanionEvent('sessions');

  const threadSummary = listMobileChatThreads().find((candidate) => candidate.id === thread.id);
  if (!threadSummary) {
    throw new Error('Started workflow, but failed to load the new companion thread summary.');
  }

  return {
    thread: threadSummary,
    session,
    queuedMessage: message,
  };
}

function enrichMobileApprovalRequests(
  approvals: MobileOverview['pendingApprovals'],
  activeWorkspace: MobileOverview['activeWorkspace'],
  activeSessions: MobileOverview['activeSessions'],
): MobileOverview['pendingApprovals'] {
  return approvals.map((approval) => {
    const session = activeSessions.find((candidate) => candidate.id === approval.sessionId);
    const workspace = resolveSessionWorkspace(session, activeWorkspace);
    const repo = session?.repoId
      ? workspace?.repos.find((candidate) => candidate.id === session.repoId)
      : undefined;

    return {
      ...approval,
      workspaceId: workspace?.id,
      workspaceName: workspace?.name,
      repoId: repo?.id ?? session?.repoId,
      repoName: repo?.name ?? repo?.path ?? approval.repoName,
      policy: buildApprovalPolicy(approval),
    };
  });
}

export function buildMobileWorkQueue(
  activeWorkspace: MobileOverview['activeWorkspace'],
  activeSessions: MobileOverview['activeSessions'],
  pendingApprovals: MobileOverview['pendingApprovals'],
  threads: MobileOverview['threads'],
): MobileWorkQueueItem[] {
  const approvalItems = pendingApprovals.map((approval): MobileWorkQueueItem => {
    const policy = approval.policy ?? buildApprovalPolicy(approval);
    return {
      id: `approval:${approval.sessionId}:${approval.requestKey}`,
      kind: 'approval',
      priority: approvalPriority(policy.risk),
      title: policy.summary,
      detail: approval.reason ?? policy.requestedAction,
      statusLabel: policy.requiresFullReview ? 'Desktop review' : 'Needs approval',
      updatedAt: approval.createdAt,
      workspaceId: approval.workspaceId,
      workspaceName: approval.workspaceName,
      repoId: approval.repoId,
      repoName: approval.repoName,
      sessionId: approval.sessionId,
      requestKey: approval.requestKey,
      risk: policy.risk,
      requiresDesktopReview: policy.requiresFullReview,
      actionLabel: policy.requiresFullReview ? 'Open Mac' : 'Decide',
    };
  });

  const sessionItems = activeSessions.map((session): MobileWorkQueueItem => {
    const thread = threads.find((candidate) => candidate.activeSessionId === session.id);
    const approvalCount = pendingApprovals.filter(
      (approval) => approval.sessionId === session.id,
    ).length;
    const workspace = resolveSessionWorkspace(session, activeWorkspace);
    const repo = session.repoId
      ? workspace?.repos.find((candidate) => candidate.id === session.repoId)
      : undefined;

    return {
      id: `session:${session.id}`,
      kind: 'session',
      priority:
        session.status === 'error'
          ? 'critical'
          : approvalCount > 0
            ? 'high'
            : session.status === 'busy' || session.status === 'starting'
              ? 'normal'
              : 'low',
      title: thread?.title ?? `${session.personaId} session`,
      detail:
        approvalCount > 0
          ? `${approvalCount} approval${approvalCount === 1 ? '' : 's'} blocking this run.`
          : session.status === 'busy'
            ? 'Agent is working on the desktop host.'
            : session.status === 'starting'
              ? 'Starting the local Codex process.'
              : session.status === 'error'
                ? 'Session hit an error and needs attention.'
                : 'Session is ready for steering or handoff.',
      statusLabel: approvalCount > 0 ? 'Blocked' : sessionStatusLabel(session.status),
      updatedAt: thread?.updatedAt ?? session.startedAt,
      workspaceId: workspace?.id,
      workspaceName: workspace?.name,
      repoId: repo?.id ?? session.repoId,
      repoName: repo?.name ?? repo?.path,
      sessionId: session.id,
      threadId: thread?.id ?? session.appThreadId,
      actionLabel:
        session.status === 'busy' || session.status === 'starting' ? 'Interrupt' : 'Open thread',
    };
  });

  const activeThreadIds = new Set(
    sessionItems
      .map((item) => item.threadId)
      .filter((threadId): threadId is string => Boolean(threadId)),
  );
  const recentThreadItems = threads
    .filter((thread) => !activeThreadIds.has(thread.id) && thread.pendingApprovalCount === 0)
    .slice(0, 4)
    .map((thread): MobileWorkQueueItem => {
      const repo = activeWorkspace?.repos[0];
      return {
        id: `thread:${thread.id}`,
        kind: 'thread',
        priority: 'low',
        title: thread.title,
        detail: thread.preview ?? `${thread.personaId} thread`,
        statusLabel: 'Recent',
        updatedAt: thread.updatedAt,
        workspaceId: thread.workspaceId,
        workspaceName:
          thread.workspaceId && thread.workspaceId === activeWorkspace?.id
            ? activeWorkspace.name
            : undefined,
        repoId: repo?.id,
        repoName: repo?.name ?? repo?.path,
        threadId: thread.id,
        sessionId: thread.activeSessionId,
        actionLabel: 'Continue',
      };
    });

  return [...approvalItems, ...sessionItems, ...recentThreadItems]
    .sort(compareWorkQueueItems)
    .slice(0, 12);
}

export function buildWorkflowDigest(
  activeWorkspace: MobileOverview['activeWorkspace'],
  activeSessions: MobileOverview['activeSessions'],
  pendingApprovals: MobileOverview['pendingApprovals'],
  threads: MobileOverview['threads'],
): MobileWorkflowDigest {
  const busySessions = activeSessions.filter((session) => session.status === 'busy').length;
  const readySessions = activeSessions.filter((session) => session.status === 'ready').length;
  const workspaceRepos = activeWorkspace?.repos.length ?? 0;

  if (!activeWorkspace) {
    return {
      health: 'unconfigured',
      headline: 'No active workspace',
      detail: 'Choose a workspace on the Mac before launching remote workflows.',
      counts: buildWorkflowCounts(
        pendingApprovals.length,
        activeSessions.length,
        busySessions,
        readySessions,
        threads.length,
        workspaceRepos,
      ),
    };
  }

  if (pendingApprovals.length > 0) {
    return {
      health: 'needs-approval',
      headline: `${pendingApprovals.length} approval${pendingApprovals.length === 1 ? '' : 's'} waiting`,
      detail: 'Remote review is the fastest way to unblock the running session.',
      counts: buildWorkflowCounts(
        pendingApprovals.length,
        activeSessions.length,
        busySessions,
        readySessions,
        threads.length,
        workspaceRepos,
      ),
    };
  }

  if (busySessions > 0) {
    return {
      health: 'busy',
      headline: `${busySessions} session${busySessions === 1 ? '' : 's'} working`,
      detail: 'Keep an eye on progress, interrupt bad turns, or send steering input.',
      counts: buildWorkflowCounts(
        pendingApprovals.length,
        activeSessions.length,
        busySessions,
        readySessions,
        threads.length,
        workspaceRepos,
      ),
    };
  }

  if (activeSessions.length > 0) {
    return {
      health: 'ready',
      headline: 'Sessions ready',
      detail: 'You can continue, summarise, review, or hand off without opening the full app.',
      counts: buildWorkflowCounts(
        pendingApprovals.length,
        activeSessions.length,
        busySessions,
        readySessions,
        threads.length,
        workspaceRepos,
      ),
    };
  }

  return {
    health: workspaceRepos > 0 ? 'idle' : 'unconfigured',
    headline: workspaceRepos > 0 ? 'Ready to launch' : 'Workspace needs repos',
    detail:
      workspaceRepos > 0
        ? 'Start a focused review, test hunt, or handoff from any companion surface.'
        : 'Add a repo to this workspace before launching agent workflows.',
    counts: buildWorkflowCounts(
      pendingApprovals.length,
      activeSessions.length,
      busySessions,
      readySessions,
      threads.length,
      workspaceRepos,
    ),
  };
}

function approvalPriority(risk: MobileWorkQueueItem['risk']): MobileWorkQueueItem['priority'] {
  if (risk === 'destructive' || risk === 'high') return 'critical';
  if (risk === 'medium') return 'high';
  return 'normal';
}

function sessionStatusLabel(status: MobileOverview['activeSessions'][number]['status']): string {
  switch (status) {
    case 'busy':
      return 'Working';
    case 'starting':
      return 'Starting';
    case 'error':
      return 'Error';
    case 'ready':
      return 'Ready';
  }
}

function compareWorkQueueItems(a: MobileWorkQueueItem, b: MobileWorkQueueItem): number {
  const priorityOrder: Record<MobileWorkQueueItem['priority'], number> = {
    critical: 0,
    high: 1,
    normal: 2,
    low: 3,
  };
  const priorityDelta = priorityOrder[a.priority] - priorityOrder[b.priority];
  if (priorityDelta !== 0) return priorityDelta;
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

function resolveSessionWorkspace(
  session: MobileOverview['activeSessions'][number] | undefined,
  activeWorkspace: MobileOverview['activeWorkspace'],
): MobileOverview['activeWorkspace'] {
  if (!session?.workspaceId) return activeWorkspace;
  if (activeWorkspace?.id === session.workspaceId) return activeWorkspace;
  return safeGetWorkspace(session.workspaceId);

function buildWorkflowCounts(
  pendingApprovals: number,
  activeSessions: number,
  busySessions: number,
  readySessions: number,
  recentThreads: number,
  workspaceRepos: number,
): MobileWorkflowDigest['counts'] {
  return {
    pendingApprovals,
    activeSessions,
    busySessions,
    readySessions,
    recentThreads,
    workspaceRepos,
  };
}

function titleFromMessage(message: string): string {
  const firstLine =
    message
      .split('\n')
      .find((line) => line.trim())
      ?.trim() ?? 'Remote workflow';
  return firstLine.length > 64 ? `${firstLine.slice(0, 61)}...` : firstLine;
}

function resolveMobileApproval(
  sessionId: string,
  requestKey: string,
  decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel' | undefined,
): void {
  if (!decision) throw new Error('Approval decision is required.');
  const approval = listPendingApprovalRequests().find(
    (candidate) => candidate.sessionId === sessionId && candidate.requestKey === requestKey,
  );
  if (!approval) throw new Error('Approval request is no longer active.');
  resolveApproval(sessionId, approval.requestId, decision);
  pushCompanionNotification(
    'approvals',
    decision === 'decline' ? 'Approval declined' : 'Approval resolved',
    'An approval was resolved from a paired companion surface.',
    'mobile',
  );
  emitCompanionEvent('approvals');
}

export function approveCarPlayApproval(approval: CarPlayApprovalRequest): void {
  const policy = buildApprovalPolicy(approval);
  if (!isCarPlayActionAllowed(policy, 'approve')) {
    throw new Error('Requires desktop review');
  }
  resolveMobileApproval(approval.sessionId, approval.requestKey, 'accept');
  pushCompanionNotification(
    'approvals',
    'Approved',
    'A low-risk approval was accepted from Anvil Drive.',
    'carplay',
  );
}

export function markCarPlayApprovalForLater(approval: CarPlayApprovalRequest): void {
  const policy = buildApprovalPolicy(approval);
  if (!isCarPlayActionAllowed(policy, 'mark-for-later')) {
    throw new Error('This approval cannot be marked for later from CarPlay.');
  }

  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO companion_review_items
       (id, workspace_id, session_id, request_key, title, summary, requested_action, risk, surface, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'carplay', 'later', ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = 'later',
         updated_at = excluded.updated_at`,
    )
    .run(
      approval.id,
      approval.workspaceId ?? null,
      approval.sessionId,
      approval.requestKey,
      approval.title,
      approval.summary,
      approval.requestedAction,
      approval.risk,
      now,
      now,
    );

  pushCompanionNotification(
    'carplay',
    'Marked for later',
    'The approval is queued for desktop review.',
    'carplay',
  );
  emitCompanionEvent('carplay');
}

function findCarPlayApproval(id: string | undefined): CarPlayApprovalRequest | undefined {
  if (!id) return undefined;
  const decoded = decodeURIComponent(id);
  return listCarPlayApprovalRequests().find((approval) => approval.id === decoded);
}

function approvalId(sessionId: string, requestKey: string): string {
  return `${sessionId}:${requestKey}`;
}

function listCompanionReviewItems(): CompanionReviewItemRow[] {
  return getDb()
    .prepare(
      `SELECT *
       FROM companion_review_items
       ORDER BY updated_at DESC
       LIMIT 100`,
    )
    .all() as CompanionReviewItemRow[];
}

function listRecentCompanionNotifications(): MobileCompanionNotification[] {
  return recentNotifications.slice(0, 25);
}

function pushCompanionNotification(
  type: MobileCompanionNotification['type'],
  title: string,
  body: string,
  surface?: MobileCompanionNotification['surface'],
): void {
  recentNotifications.unshift({
    id: randomUUID(),
    type,
    surface,
    title,
    body,
    createdAt: new Date().toISOString(),
  });
  recentNotifications.splice(25);
}

function safeGetWorkspace(workspaceId: string): MobileOverview['activeWorkspace'] {
  try {
    return getWorkspace(workspaceId);
  } catch {
    return undefined;
  }
}

function focusDesktop(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
}

function writeEventStream(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  const unsubscribe = onCompanionEvent((event) => {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  });
  const interval = setInterval(() => {
    res.write(
      `event: heartbeat\ndata: ${JSON.stringify({ generatedAt: new Date().toISOString() })}\n\n`,
    );
  }, 30_000);
  res.on('close', () => {
    clearInterval(interval);
    unsubscribe();
  });
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {} as T;
  return JSON.parse(text) as T;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  setCommonHeaders(res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function setCommonHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function mapDevice(row: MobileCompanionDeviceRow): MobileCompanionDevice {
  return {
    id: row.id,
    name: row.name,
    clientType: row.client_type ?? 'mobile',
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
  };
}

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalAttachResult, TerminalSessionSummary } from '../../../shared/types.js';
import {
  BROWSER_PREVIEW_MAX_IMAGE_BYTES,
  BROWSER_PREVIEW_LOAD_TIMEOUT_MS,
  BROWSER_TERMINAL_MAX_COUNT_PER_GRANT,
  BROWSER_TERMINAL_MAX_INPUT_CHARS,
  BROWSER_TERMINAL_MAX_READ_CHARS,
  createDesktopRepoPreviewCapture,
  createBrowserWorkspaceTools,
  type BrowserWorkspaceRuntimeContext,
  type BrowserWorkspaceTerminalAdapter,
} from '../browser-workspace-tools.service.js';

interface FakeTerminal {
  session: TerminalSessionSummary;
  output: TerminalAttachResult['output'];
}

function context(
  overrides: Partial<BrowserWorkspaceRuntimeContext> = {},
): BrowserWorkspaceRuntimeContext {
  return {
    grantId: 'grant-a',
    workspaceId: 'workspace-a',
    repoIds: ['repo-a'],
    scopes: ['terminal'],
    expiresAt: 10_000,
    ...overrides,
  };
}

function makeSummary(
  terminalId: string,
  workspaceId: string,
  repoId: string,
): TerminalSessionSummary {
  return {
    terminalId,
    workspaceId,
    repoId,
    cwd: `/repos/${repoId}`,
    status: 'running',
    createdAt: '2026-09-22T00:00:00.000Z',
    sequence: 0,
  };
}

function makeAdapter(): {
  adapter: BrowserWorkspaceTerminalAdapter;
  sessions: Map<string, FakeTerminal>;
  close: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
} {
  const sessions = new Map<string, FakeTerminal>();
  const close = vi.fn((terminalId: string) => sessions.delete(terminalId));
  const create = vi.fn(
    (
      workspaceId: string,
      repoId: string,
      cwd: string,
      options?: { sessionKey?: string; env?: Readonly<Record<string, string>> },
    ) => {
      const terminalId = `${workspaceId}-${repoId}-${options?.sessionKey ?? 'legacy'}`;
      const session = { ...makeSummary(terminalId, workspaceId, repoId), cwd };
      sessions.set(terminalId, { session, output: [] });
      return session;
    },
  );
  const adapter: BrowserWorkspaceTerminalAdapter = {
    create,
    read: vi.fn((terminalId: string, afterSequence = 0) => {
      const entry = sessions.get(terminalId);
      if (!entry) throw new Error('missing terminal');
      return {
        session: { ...entry.session, sequence: entry.output.at(-1)?.sequence ?? 0 },
        output: entry.output.filter((chunk) => chunk.sequence > afterSequence),
      };
    }),
    write: vi.fn(),
    resize: vi.fn(),
    close,
  };
  return { adapter, sessions, close, create };
}

function makePreviewWindow(
  options: { externalSubresource?: boolean; externalNavigation?: boolean } = {},
) {
  let beforeRequest:
    | ((
        details: { url: string; resourceType?: string },
        callback: (result: { cancel: boolean }) => void,
      ) => void)
    | undefined;
  let beforeSendHeaders:
    | ((
        details: { requestHeaders: Record<string, string> },
        callback: (result: { requestHeaders: Record<string, string> }) => void,
      ) => void)
    | undefined;
  const onceListeners = new Map<string, (...args: unknown[]) => void>();
  const eventListeners = new Map<string, (...args: unknown[]) => void>();
  const sessionListeners = new Map<string, (...args: unknown[]) => void>();
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const capturePage = vi.fn(async () => ({ toPNG: () => png }));
  const close = vi.fn();
  const destroy = vi.fn(() => close());
  const setProxy = vi.fn(async () => undefined);
  const session = {
    setProxy,
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(),
    setCertificateVerifyProc: vi.fn(),
    webRequest: {
      onBeforeRequest: vi.fn((_filter: unknown, listener: typeof beforeRequest) => {
        beforeRequest = listener;
      }),
      onBeforeSendHeaders: vi.fn((_filter: unknown, listener: typeof beforeSendHeaders) => {
        beforeSendHeaders = listener;
      }),
    },
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      sessionListeners.set(event, listener);
    }),
  };
  const previewWindow = {
    webContents: {
      session,
      once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        onceListeners.set(event, listener);
      }),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        eventListeners.set(event, listener);
      }),
      setWindowOpenHandler: vi.fn((handler: () => { action: 'deny' }) => {
        eventListeners.set('window-open', handler);
      }),
      capturePage,
    },
    loadURL: vi.fn(async (url: string) => {
      const requests = [
        { url, resourceType: 'mainFrame' },
        ...(options.externalSubresource
          ? [{ url: 'https://outside.example/asset.js', resourceType: 'script' }]
          : []),
        ...(options.externalNavigation
          ? [{ url: 'https://outside.example/', resourceType: 'mainFrame' }]
          : []),
      ];
      for (const request of requests) {
        let canceled = false;
        beforeRequest?.(request, (result) => {
          canceled = result.cancel;
        });
        if (canceled && request.resourceType === 'mainFrame') {
          onceListeners.get('did-fail-load')?.({}, -3, 'ERR_ABORTED', request.url, true);
          return;
        }
      }
      onceListeners.get('did-finish-load')?.();
    }),
    close,
    destroy,
  };
  return {
    previewWindow,
    onceListeners,
    eventListeners,
    sessionListeners,
    session,
    capturePage,
    close,
    destroy,
    setProxy,
    getBeforeSendHeaders: () => beforeSendHeaders,
    timeoutMs: BROWSER_PREVIEW_LOAD_TIMEOUT_MS,
  };
}

describe('browser workspace tools', () => {
  let clock = 1_000;
  let fake: ReturnType<typeof makeAdapter>;

  beforeEach(() => {
    clock = 1_000;
    fake = makeAdapter();
  });

  it('requires the explicit terminal scope and approved repository binding', async () => {
    const tools = createBrowserWorkspaceTools({
      now: () => clock,
      resolveRepoCwd: () => '/desktop/repo',
      terminal: fake.adapter,
    });

    await expect(
      tools.execute({
        type: 'terminal.create',
        context: context({ scopes: ['preview'] }),
        repoId: 'repo-a',
      }),
    ).rejects.toThrow('terminal scope');
    await expect(
      tools.execute({ type: 'terminal.create', context: context(), repoId: 'repo-b' }),
    ).rejects.toThrow('not approved');
    expect(fake.create).not.toHaveBeenCalled();
  });

  it('resolves cwd on Desktop, isolates terminals per grant, and bounds terminal count', async () => {
    const previousApiKey = process.env.OPENAI_API_KEY;
    const previousSshAuth = process.env.SSH_AUTH_SOCK;
    const previousHttpProxy = process.env.HTTP_PROXY;
    process.env.OPENAI_API_KEY = 'ambient-secret';
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock';
    process.env.HTTP_PROXY = 'http://user:password@example.test:8080';
    const tools = createBrowserWorkspaceTools({
      now: () => clock,
      resolveRepoCwd: vi.fn((workspaceId, repoId) => `/desktop/${workspaceId}/${repoId}`),
      terminal: fake.adapter,
    });
    try {
      const first = await tools.execute({
        type: 'terminal.create',
        context: context(),
        repoId: 'repo-a',
      });
      const duplicate = await tools.execute({
        type: 'terminal.create',
        context: context(),
        repoId: 'repo-a',
      });

      expect(first.type).toBe('terminal.created');
      expect(duplicate).toEqual(first);
      expect(fake.create).toHaveBeenCalledOnce();
      expect(fake.create.mock.calls[0][2]).toBe('/desktop/workspace-a/repo-a');
      expect(fake.create.mock.calls[0][3]).toMatchObject({ sessionKey: 'browser-grant-a' });
      expect(fake.create.mock.calls[0][3].env).not.toHaveProperty('OPENAI_API_KEY');
      expect(fake.create.mock.calls[0][3].env).not.toHaveProperty('SSH_AUTH_SOCK');
      expect(fake.create.mock.calls[0][3].env).not.toHaveProperty('HTTP_PROXY');

      const repos = Array.from(
        { length: BROWSER_TERMINAL_MAX_COUNT_PER_GRANT },
        (_, index) => `repo-${index}`,
      );
      const grant = context({
        grantId: 'grant-count',
        repoIds: [...repos, 'repo-extra'],
      });
      for (const repoId of repos) {
        await tools.execute({ type: 'terminal.create', context: grant, repoId });
      }
      await expect(
        tools.execute({ type: 'terminal.create', context: grant, repoId: 'repo-extra' }),
      ).rejects.toThrow('terminal limit');
    } finally {
      if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousApiKey;
      if (previousSshAuth === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = previousSshAuth;
      if (previousHttpProxy === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = previousHttpProxy;
    }
  });

  it('does not permit attaching, writing, or resizing another grant terminal', async () => {
    const tools = createBrowserWorkspaceTools({
      now: () => clock,
      resolveRepoCwd: () => '/desktop/repo',
      terminal: fake.adapter,
    });
    const created = await tools.execute({
      type: 'terminal.create',
      context: context(),
      repoId: 'repo-a',
    });
    if (created.type !== 'terminal.created') throw new Error('expected terminal');

    const foreign = context({ grantId: 'grant-b' });
    await expect(
      tools.execute({
        type: 'terminal.read',
        context: foreign,
        repoId: 'repo-a',
        terminalId: created.terminal.terminalId,
      }),
    ).rejects.toThrow('not owned');
    await expect(
      tools.execute({
        type: 'terminal.write',
        context: context(),
        repoId: 'repo-a',
        terminalId: created.terminal.terminalId,
        data: 'x'.repeat(BROWSER_TERMINAL_MAX_INPUT_CHARS + 1),
      }),
    ).rejects.toThrow('exceeds');
    await expect(
      tools.execute({
        type: 'terminal.resize',
        context: context(),
        repoId: 'repo-a',
        terminalId: created.terminal.terminalId,
        cols: 0,
        rows: 24,
      }),
    ).rejects.toThrow('cols');
  });

  it('bounds reads and closes all PTYs when a grant is revoked', async () => {
    const tools = createBrowserWorkspaceTools({
      now: () => clock,
      resolveRepoCwd: () => '/desktop/repo',
      terminal: fake.adapter,
    });
    const created = await tools.execute({
      type: 'terminal.create',
      context: context(),
      repoId: 'repo-a',
    });
    if (created.type !== 'terminal.created') throw new Error('expected terminal');
    const entry = fake.sessions.get(created.terminal.terminalId)!;
    entry.output = [{ sequence: 1, data: 'x'.repeat(BROWSER_TERMINAL_MAX_READ_CHARS + 20) }];

    const read = await tools.execute({
      type: 'terminal.read',
      context: context(),
      repoId: 'repo-a',
      terminalId: created.terminal.terminalId,
    });
    expect(read.type).toBe('terminal.read');
    if (read.type === 'terminal.read') {
      expect(read.terminal.output[0].data).toHaveLength(BROWSER_TERMINAL_MAX_READ_CHARS);
    }

    tools.revokeGrant('grant-a');
    expect(fake.close).toHaveBeenCalledWith(created.terminal.terminalId);
    expect(tools.getDiagnostics()).toEqual({ activeTerminals: 0, grants: 0 });
    await expect(
      tools.execute({
        type: 'terminal.read',
        context: context(),
        repoId: 'repo-a',
        terminalId: created.terminal.terminalId,
      }),
    ).rejects.toThrow('not owned');
  });

  it('expires a grant before a command and tears down its PTY', async () => {
    const tools = createBrowserWorkspaceTools({
      now: () => clock,
      resolveRepoCwd: () => '/desktop/repo',
      terminal: fake.adapter,
    });
    const expiring = context({ expiresAt: 1_500 });
    const created = await tools.execute({
      type: 'terminal.create',
      context: expiring,
      repoId: 'repo-a',
    });
    if (created.type !== 'terminal.created') throw new Error('expected terminal');
    clock = 1_500;

    await expect(
      tools.execute({
        type: 'terminal.read',
        context: expiring,
        repoId: 'repo-a',
        terminalId: created.terminal.terminalId,
      }),
    ).rejects.toThrow('expired');
    expect(fake.close).toHaveBeenCalledWith(created.terminal.terminalId);
  });

  it('offers only an authenticated Desktop screenshot hook, never an interactive URL proxy', async () => {
    const capture = vi.fn(async ({ repoId, refresh }: { repoId: string; refresh: boolean }) => {
      expect(repoId).toBe('repo-a');
      expect(typeof refresh).toBe('boolean');
      return { data: 'iVBORw0KGgo=', capturedAt: 2_000 };
    });
    const tools = createBrowserWorkspaceTools({
      now: () => clock,
      resolveRepoCwd: () => '/desktop/repo',
      terminal: fake.adapter,
      capturePreview: capture,
    });
    const previewContext = context({ scopes: ['preview'] });
    await expect(
      tools.execute({
        type: 'preview.screenshot',
        context: previewContext,
        repoId: 'repo-a',
        refresh: true,
      }),
    ).resolves.toEqual({
      type: 'preview.screenshot.result',
      status: 'available',
      mimeType: 'image/png',
      data: 'iVBORw0KGgo=',
      capturedAt: 2_000,
    });
    expect(capture).toHaveBeenCalledOnce();

    const unavailable = createBrowserWorkspaceTools({
      now: () => clock,
      resolveRepoCwd: () => '/desktop/repo',
      terminal: fake.adapter,
    });
    await expect(
      unavailable.execute({
        type: 'preview.screenshot',
        context: previewContext,
        repoId: 'repo-a',
      }),
    ).resolves.toMatchObject({ status: 'unavailable' });
    await expect(
      tools.execute({
        type: 'preview.screenshot',
        context: previewContext,
        repoId: 'repo-a',
        refresh: false,
      }),
    ).resolves.toMatchObject({ status: 'available' });
    expect(BROWSER_PREVIEW_MAX_IMAGE_BYTES).toBeGreaterThan(0);
  });

  it('captures an approved repo dev target in an isolated, credential-free window', async () => {
    const fakeWindow = makePreviewWindow();
    const createWindow = vi.fn(() => fakeWindow.previewWindow);
    const capture = createDesktopRepoPreviewCapture({
      listTargets: () => [
        {
          id: 'target-a',
          url: 'http://localhost:5173',
          port: 5173,
          label: 'localhost:5173',
          terminalId: 'workspace-a-repo-a',
          detectedAt: '2026-09-22T00:00:00.000Z',
        },
      ],
      listTerminals: () => [makeSummary('workspace-a-repo-a', 'workspace-a', 'repo-a')],
      createWindow,
    });

    const result = await capture({ context: context(), repoId: 'repo-a', refresh: true });

    expect(result).toMatchObject({ data: 'iVBORw0KGgo=', capturedAt: expect.any(Number) });
    expect(fakeWindow.close).toHaveBeenCalledOnce();
    expect(fakeWindow.destroy).toHaveBeenCalledOnce();
    expect(fakeWindow.setProxy).toHaveBeenCalledWith({ mode: 'direct' });
    expect(fakeWindow.previewWindow.webContents.capturePage).toHaveBeenCalledOnce();
    expect(createWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        show: false,
        webPreferences: expect.objectContaining({
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          partition: expect.stringMatching(/^preview-/),
        }),
      }),
    );
    expect(BROWSER_PREVIEW_LOAD_TIMEOUT_MS).toBe(10_000);

    const sendHeaders = fakeWindow.getBeforeSendHeaders();
    expect(sendHeaders).toBeDefined();
    let headers: Record<string, string> = {};
    sendHeaders?.(
      {
        requestHeaders: {
          Cookie: 'desktop-cookie',
          Authorization: 'desktop-token',
          Accept: 'text/html',
        },
      },
      (result) => {
        headers = result.requestHeaders;
      },
    );
    expect(headers).toEqual({ Accept: 'text/html' });
  });

  it('fails closed on external main-frame navigation but tolerates blocked subresources', async () => {
    const listTargets = () => [
      {
        id: 'target-a',
        url: 'http://127.0.0.1:4173',
        port: 4173,
        label: '127.0.0.1:4173',
        terminalId: 'workspace-a-repo-a',
        detectedAt: '2026-09-22T00:00:00.000Z',
      },
    ];
    const listTerminals = () => [makeSummary('workspace-a-repo-a', 'workspace-a', 'repo-a')];

    const blockedWindow = makePreviewWindow({ externalNavigation: true });
    const blockedCapture = createDesktopRepoPreviewCapture({
      listTargets,
      listTerminals,
      createWindow: () => blockedWindow.previewWindow,
    });
    await expect(
      blockedCapture({ context: context(), repoId: 'repo-a', refresh: true }),
    ).resolves.toEqual({ unavailable: 'desktop-preview-blocked' });
    expect(blockedWindow.capturePage).not.toHaveBeenCalled();
    expect(blockedWindow.close).toHaveBeenCalledOnce();
    expect(blockedWindow.destroy).toHaveBeenCalledOnce();

    // An optional external subresource is cancelled without failing the frame.
    const tolerantWindow = makePreviewWindow({ externalSubresource: true });
    const tolerantCapture = createDesktopRepoPreviewCapture({
      listTargets,
      listTerminals,
      createWindow: () => tolerantWindow.previewWindow,
    });
    await expect(
      tolerantCapture({ context: context(), repoId: 'repo-a', refresh: true }),
    ).resolves.toMatchObject({ data: 'iVBORw0KGgo=' });
    expect(tolerantWindow.capturePage).toHaveBeenCalledOnce();

    const missingCapture = createDesktopRepoPreviewCapture({
      listTargets: () => [],
      listTerminals: () => [],
      createWindow: () => {
        throw new Error('must not create a window');
      },
    });
    await expect(
      missingCapture({ context: context(), repoId: 'repo-a', refresh: false }),
    ).resolves.toEqual({ unavailable: 'repo-dev-server-not-found' });
  });

  it('denies permission, device, and display-media requests and refuses auth/TLS', async () => {
    const fakeWindow = makePreviewWindow();
    const capture = createDesktopRepoPreviewCapture({
      listTargets: () => [
        {
          id: 'target-a',
          url: 'http://localhost:5173',
          port: 5173,
          label: 'localhost:5173',
          terminalId: 'workspace-a-repo-a',
          detectedAt: '2026-09-22T00:00:00.000Z',
        },
      ],
      listTerminals: () => [makeSummary('workspace-a-repo-a', 'workspace-a', 'repo-a')],
      createWindow: () => fakeWindow.previewWindow,
    });

    await expect(
      capture({ context: context(), repoId: 'repo-a', refresh: false }),
    ).resolves.toMatchObject({ data: 'iVBORw0KGgo=' });

    const session = fakeWindow.session;
    const permissionRequest = session.setPermissionRequestHandler.mock.calls[0]?.[0] as (
      webContents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
    ) => void;
    let granted: boolean | undefined;
    permissionRequest?.({}, 'clipboard-read', (value) => {
      granted = value;
    });
    expect(granted).toBe(false);
    const permissionCheck = session.setPermissionCheckHandler.mock.calls[0]?.[0] as (
      ...args: unknown[]
    ) => boolean;
    expect(permissionCheck?.({}, 'media', 'http://localhost:5173', {})).toBe(false);
    const devicePermission = session.setDevicePermissionHandler.mock.calls[0]?.[0] as (
      details: unknown,
    ) => boolean;
    expect(devicePermission?.({ deviceType: 'serial' })).toBe(false);
    const displayMedia = session.setDisplayMediaRequestHandler.mock.calls[0]?.[0] as (
      request: unknown,
      callback: (streams: Record<string, unknown>) => void,
    ) => void;
    let streams: Record<string, unknown> | undefined;
    displayMedia?.({}, (value) => {
      streams = value;
    });
    expect(streams).toEqual({ video: false, audio: false });

    // Certificate verification fails closed for every chain.
    const verifyProc = session.setCertificateVerifyProc.mock.calls[0]?.[0] as (
      request: unknown,
      callback: (verificationResult: number) => void,
    ) => void;
    let verification: number | undefined;
    verifyProc?.({ hostname: 'localhost' }, (value) => {
      verification = value;
    });
    expect(verification).toBe(-2);

    // An HTTP-auth challenge is refused rather than answered.
    const login = fakeWindow.eventListeners.get('login');
    expect(login).toBeDefined();
    let prevented = false;
    login?.({ preventDefault: () => (prevented = true) }, {}, {}, () => undefined);
    expect(prevented).toBe(true);

    // Downloads stay blocked too.
    const download = fakeWindow.sessionListeners.get('will-download');
    expect(download).toBeDefined();
  });
});

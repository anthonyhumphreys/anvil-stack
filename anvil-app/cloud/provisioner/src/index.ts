/**
 * anvil-mesh-provisioner — Cloudflare Sandbox bridge for anvil-worker
 * environments (ENV-04 BYO `cloudflare-sandbox`, ENV-09 `anvil-managed`
 * behind the backend's MANAGED_PROVISIONER service binding).
 *
 * Routes (Bearer-authenticated unless ALLOW_UNAUTHENTICATED=true):
 *   GET    /v1/health                    → {ok:true}  (connection validation)
 *   POST   /v1/environments              {environmentId, ttlSeconds, bootstrap}
 *   GET    /v1/environments/:id          → running | suspended | unknown
 *   POST   /v1/environments/:id/boot     {bootstrap}  (container-replace recovery)
 *   DELETE /v1/environments/:id          → {ok:true}
 *
 * Secrets stay in the Worker: the pairing payload inside `bootstrap` is
 * passed to the sandbox process env only — never logged, never persisted.
 * Sandbox IDs are provider refs (the app stores them in
 * CloudEnvironmentHandle.providerRef); durable job context lives in the
 * backend, so a container replacement just needs a fresh /boot call.
 */
import { getSandbox, type Sandbox, type SandboxEnv } from '@cloudflare/sandbox';
import { validBootstrap, validTtlSeconds } from './bootstrap';
import type { MeshEnvironmentBootstrap } from './bootstrap';
import type { ThreadSandbox } from './checkpointing-sandbox';
import { bootWithSandbox, isBootProcess } from './lifecycle';

export { Sandbox } from '@cloudflare/sandbox';
export { ThreadSandbox } from './checkpointing-sandbox';

interface Env extends SandboxEnv<Sandbox> {
  ThreadSandbox: DurableObjectNamespace<ThreadSandbox>;
  PROVISIONER_TOKEN?: string;
  ALLOW_UNAUTHENTICATED?: string;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function unauthorized(): Response {
  return json({ error: 'unauthorized' }, 401);
}

function authorized(request: Request, env: Env): boolean {
  if (env.ALLOW_UNAUTHENTICATED === 'true') return true;
  const token = env.PROVISIONER_TOKEN;
  if (typeof token !== 'string' || token.length === 0) return false; // fail closed
  return request.headers.get('authorization') === `Bearer ${token}`;
}

interface CreateBody {
  environmentId?: unknown;
  ttlSeconds?: unknown;
  bootstrap?: unknown;
}

interface BootBody {
  bootstrap?: unknown;
}

function recordBody(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sandboxId(raw: string): string | null {
  // Environment ids are already provider-safe; keep a conservative guard so a
  // hostile id can't escape the sandbox namespace.
  return /^[A-Za-z0-9_-]{1,120}$/.test(raw) ? raw : null;
}

function usesThreadSandbox(id: string): boolean {
  // New remote chats and their isolated staging smoke use the v2 namespace.
  // Existing environment IDs remain pinned to the legacy namespace forever.
  return /^remote-[0-9a-f-]{36}$/i.test(id) || /^ci-smoke-[0-9a-f-]{36}$/i.test(id);
}

function threadSandbox(env: Env, id: string): DurableObjectStub<ThreadSandbox> {
  return env.ThreadSandbox.get(env.ThreadSandbox.idFromName(id));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!authorized(request, env)) return unauthorized();

    if (request.method === 'GET' && url.pathname === '/v1/health') {
      return json({ ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/v1/environments') {
      const body = recordBody(await request.json().catch(() => ({}))) as CreateBody;
      const id = typeof body.environmentId === 'string' ? sandboxId(body.environmentId) : null;
      if (id === null) return json({ error: 'invalid environmentId' }, 400);
      if (!validBootstrap(body.bootstrap)) return json({ error: 'invalid bootstrap' }, 400);
      if (body.bootstrap.environmentId !== id) {
        return json({ error: 'bootstrap environmentId mismatch' }, 400);
      }
      if (!validTtlSeconds(body.ttlSeconds) || body.ttlSeconds !== body.bootstrap.ttlSeconds) {
        return json({ error: 'ttlSeconds must match bootstrap' }, 400);
      }
      try {
        const { processId, reused } = usesThreadSandbox(id)
          ? await threadSandbox(env, id).boot(body.bootstrap as MeshEnvironmentBootstrap)
          : await (async () => {
              const sandbox = getSandbox(env.Sandbox, id);
              await sandbox.setKeepAlive(true);
              return bootWithSandbox(sandbox, body.bootstrap as MeshEnvironmentBootstrap);
            })();
        return json({ providerRef: id, processId, reused }, reused ? 200 : 201);
      } catch {
        return json({ error: 'sandbox_boot_failed' }, 502);
      }
    }

    const match = /^\/v1\/environments\/([A-Za-z0-9_-]{1,120})(\/(?:boot|suspend))?$/.exec(
      url.pathname,
    );
    if (match !== null) {
      const id = match[1];
      const useThread = usesThreadSandbox(id);

      if (request.method === 'GET' && match[2] === undefined) {
        let running;
        try {
          if (useThread) {
            const sandbox = threadSandbox(env, id);
            const lifecycle = await sandbox.lifecycleStatus();
            if (!lifecycle.running) {
              if (lifecycle.hasSnapshot) return json({ status: 'suspended' });
              await sandbox.start();
            }
            running = await sandbox.listProcesses();
          } else {
            // Keep the established path for the immutable default-policy app.
            running = await getSandbox(env.Sandbox, id).listProcesses();
          }
        } catch {
          return json({ error: 'sandbox_status_failed' }, 502);
        }
        const live = running.some(isBootProcess);
        // A sandbox with no live processes may be pending a container start or
        // already gone — the backend's TTL sweep + worker self-report carry
        // the authoritative lifecycle, so report 'unknown' rather than lie.
        return json({ status: live ? 'running' : 'unknown' });
      }

      if (request.method === 'POST' && match[2] === '/suspend') {
        if (!useThread) return json({ error: 'snapshots require the thread environment' }, 409);
        try {
          const sandbox = threadSandbox(env, id);
          const result = await sandbox.suspendAndSnapshot();
          return json({ ok: true, size: result.size });
        } catch {
          return json({ error: 'sandbox_suspend_failed' }, 502);
        }
      }

      if (request.method === 'POST' && match[2] === '/boot') {
        if (!useThread)
          return json({ error: 'snapshot restore requires the thread environment' }, 409);
        const body = recordBody(await request.json().catch(() => ({}))) as BootBody;
        if (!validBootstrap(body.bootstrap)) return json({ error: 'invalid bootstrap' }, 400);
        if (body.bootstrap.environmentId !== id) {
          return json({ error: 'bootstrap environmentId mismatch' }, 400);
        }
        const sandbox = threadSandbox(env, id);
        if (!(await sandbox.hasSnapshot())) {
          return json({ error: 'environment_snapshot_missing' }, 409);
        }
        try {
          const { processId, reused } = await sandbox.boot(body.bootstrap);
          return json({ providerRef: id, processId, reused }, reused ? 200 : 201);
        } catch {
          return json({ error: 'sandbox_boot_failed' }, 502);
        }
      }

      if (request.method === 'DELETE' && match[2] === undefined) {
        try {
          if (useThread) {
            await threadSandbox(env, id).discardSnapshot();
          } else {
            await getSandbox(env.Sandbox, id).destroy();
          }
          return json({ ok: true });
        } catch {
          // Do not claim termination when the provider rejected the request.
          return json({ error: 'sandbox_termination_failed' }, 502);
        }
      }
    }

    return json({ error: 'not_found' }, 404);
  },
} satisfies ExportedHandler<Env>;

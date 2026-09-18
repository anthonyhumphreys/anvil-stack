/**
 * anvil-mesh-provisioner — Cloudflare Sandbox bridge for anvil-worker
 * environments (ENV-04 BYO `cloudflare-sandbox`, ENV-09 `anvil-managed`
 * behind the backend's MANAGED_PROVISIONER service binding).
 *
 * Routes (Bearer-authenticated unless ALLOW_UNAUTHENTICATED=true):
 *   GET    /v1/health                    → {ok:true}  (connection validation)
 *   POST   /v1/environments              {environmentId, ttlSeconds, bootstrap}
 *   GET    /v1/environments/:id          → {status: 'running'|'unknown'}
 *   POST   /v1/environments/:id/boot     {bootstrap}  (container-replace recovery)
 *   DELETE /v1/environments/:id          → {ok:true}
 *
 * Secrets stay in the Worker: the pairing payload inside `bootstrap` is
 * passed to the sandbox process env only — never logged, never persisted.
 * Sandbox IDs are provider refs (the app stores them in
 * CloudEnvironmentHandle.providerRef); durable job context lives in the
 * backend, so a container replacement just needs a fresh /boot call.
 */
import { getSandbox, type SandboxEnv } from '@cloudflare/sandbox';

export { Sandbox } from '@cloudflare/sandbox';

interface Env extends SandboxEnv {
  PROVISIONER_TOKEN?: string;
  ALLOW_UNAUTHENTICATED?: string;
}

const BOOT_ARGV = ['/opt/anvil/bin/anvil-worker-boot'] as const;

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

function validBootstrap(bootstrap: unknown): boolean {
  const doc = bootstrap as Record<string, unknown> | null;
  return (
    doc?.kind === 'anvil.mesh-environment' &&
    doc?.schemaVersion === '0.1' &&
    typeof doc.environmentId === 'string' &&
    doc.environmentId.length > 0 &&
    typeof doc.backendUrl === 'string' &&
    doc.backendUrl.length > 0 &&
    typeof doc.pairing === 'string' &&
    doc.pairing.startsWith('anvil-pair-') &&
    typeof doc.ttlSeconds === 'number' &&
    doc.ttlSeconds > 0
  );
}

function sandboxId(raw: string): string | null {
  // Environment ids are already provider-safe; keep a conservative guard so a
  // hostile id can't escape the sandbox namespace.
  return /^[A-Za-z0-9_-]{1,120}$/.test(raw) ? raw : null;
}

async function bootEnvironment(
  env: Env,
  id: string,
  bootstrap: unknown,
): Promise<{ processId: string; reused: boolean }> {
  const sandbox = getSandbox(env.Sandbox, id);
  // Idempotent: a live boot process means this env is already provisioned.
  // listProcesses doesn't start a container, so a cold sandbox returns [] —
  // and a dead one may throw, which just means there's nothing to reuse.
  const running = await sandbox.listProcesses().catch(() => [] as { id: string; state: string }[]);
  const live = running.find((p) => p.state === 'running');
  if (live !== undefined) return { processId: live.id, reused: true };
  const proc = await sandbox.exec(BOOT_ARGV, {
    env: { ANVIL_BOOTSTRAP_JSON: JSON.stringify(bootstrap) },
  });
  return { processId: proc.id, reused: false };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!authorized(request, env)) return unauthorized();

    if (request.method === 'GET' && url.pathname === '/v1/health') {
      return json({ ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/v1/environments') {
      const body = (await request.json().catch(() => ({}))) as CreateBody;
      const id =
        typeof body.environmentId === 'string' ? sandboxId(body.environmentId) : null;
      if (id === null) return json({ error: 'invalid environmentId' }, 400);
      if (!validBootstrap(body.bootstrap)) return json({ error: 'invalid bootstrap' }, 400);
      if (body.bootstrap !== undefined) {
        const doc = body.bootstrap as Record<string, unknown>;
        if (doc.environmentId !== id) {
          return json({ error: 'bootstrap environmentId mismatch' }, 400);
        }
      }
      const { processId, reused } = await bootEnvironment(env, id, body.bootstrap);
      return json({ providerRef: id, processId, reused }, reused ? 200 : 201);
    }

    const match = /^\/v1\/environments\/([A-Za-z0-9_-]{1,120})(\/boot)?$/.exec(url.pathname);
    if (match !== null) {
      const id = match[1];
      const sandbox = getSandbox(env.Sandbox, id);

      if (request.method === 'GET' && match[2] === undefined) {
        const running = await sandbox.listProcesses().catch(() => null);
        const live = running?.some((p) => p.state === 'running') ?? false;
        // A sandbox with no live processes may be pending a container start or
        // already gone — the backend's TTL sweep + worker self-report carry
        // the authoritative lifecycle, so report 'unknown' rather than lie.
        return json({ status: live ? 'running' : 'unknown' });
      }

      if (request.method === 'POST' && match[2] === '/boot') {
        const body = (await request.json().catch(() => ({}))) as BootBody;
        if (!validBootstrap(body.bootstrap)) return json({ error: 'invalid bootstrap' }, 400);
        const { processId, reused } = await bootEnvironment(env, id, body.bootstrap);
        return json({ providerRef: id, processId, reused }, reused ? 200 : 201);
      }

      if (request.method === 'DELETE' && match[2] === undefined) {
        // Termination is idempotent: a vanished sandbox is already at the
        // goal state, so a destroy error is not a teardown failure.
        await sandbox.destroy().catch(() => undefined);
        return json({ ok: true });
      }
    }

    return json({ error: 'not_found' }, 404);
  },
} satisfies ExportedHandler<Env>;

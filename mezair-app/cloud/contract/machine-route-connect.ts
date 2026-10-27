import type { MeshMachineRoute } from './machine.js';
import { meshMachineRouteRank } from './machine-route-policy';

export const MESH_ROUTE_HEAD_START_MS = 250;
export const MESH_ROUTE_CONNECT_BUDGET_MS = 30_000;
export const MESH_ROUTE_AUTH_TIMEOUT_MS = 20_000;

function cancelled(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('machine-route-cancelled');
}

/** Also bounds adapters which do not settle promptly after an abort. */
export function boundedMeshOperation<T>(
  run: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal,
  timeoutMs: number,
  disposeLate?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      parent.removeEventListener('abort', abort);
    };
    const abort = (): void => {
      if (settled) return;
      settled = true;
      controller.abort(parent.reason ?? new Error('machine-route-timeout'));
      cleanup();
      reject(cancelled(controller.signal));
    };
    const timer = setTimeout(abort, timeoutMs);
    parent.addEventListener('abort', abort, { once: true });
    if (parent.aborted) {
      abort();
      return;
    }
    Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) throw cancelled(controller.signal);
        return run(controller.signal);
      })
      .then(
        (value) => {
          if (settled) {
            disposeLate?.(value);
            return;
          }
          settled = true;
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      );
  });
}

class MeshSemaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly limit: number) {}

  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve, reject) => {
      const enter = (): void => {
        signal.removeEventListener('abort', abort);
        this.active += 1;
        resolve();
      };
      const abort = (): void => {
        const index = this.queue.indexOf(enter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(cancelled(signal));
      };
      if (signal.aborted) {
        reject(cancelled(signal));
        return;
      }
      if (this.active < this.limit) enter();
      else {
        this.queue.push(enter);
        signal.addEventListener('abort', abort, { once: true });
      }
    });
    try {
      if (signal.aborted) throw cancelled(signal);
      return await operation();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}

const probeSlots = new MeshSemaphore(8);
const authenticationSlots = new MeshSemaphore(4);

/** Read-only probes race; one proof-bound session is authenticated at a time per host. */
export async function connectMeshRoutes<TInfo, TConnection>(input: {
  routes: readonly MeshMachineRoute[];
  probe: (route: MeshMachineRoute, signal: AbortSignal) => Promise<TInfo>;
  connect: (route: MeshMachineRoute, info: TInfo, signal: AbortSignal) => Promise<TConnection>;
  dispose: (connection: TConnection) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<TConnection> {
  const outer = input.signal ?? new AbortController().signal;
  return boundedMeshOperation(
    async (signal) => {
      const routes = [...input.routes].sort(
        (a, b) => meshMachineRouteRank(a) - meshMachineRouteRank(b),
      );
      if (routes.length === 0) throw new Error('route-unavailable');
      const bestRank = meshMachineRouteRank(routes[0]!);
      const preferred = routes.filter((route) => meshMachineRouteRank(route) === bestRank);
      const fallback = routes.filter((route) => meshMachineRouteRank(route) !== bestRank);
      const probes = new AbortController();
      const abortProbes = (): void => probes.abort(signal.reason);
      signal.addEventListener('abort', abortProbes, { once: true });
      const ready: Array<{ route: MeshMachineRoute; info: TInfo }> = [];
      let remaining = routes.length;
      let wake: (() => void) | undefined;
      let lastError: unknown = new Error('route-unavailable');
      let authenticationError: unknown;
      let gateTimer: ReturnType<typeof setTimeout> | undefined;
      let openGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      if (fallback.length === 0) openGate();
      else gateTimer = setTimeout(openGate, MESH_ROUTE_HEAD_START_MS);
      const onAbort = (): void => {
        openGate();
        wake?.();
      };
      probes.signal.addEventListener('abort', onAbort, { once: true });
      const probe = async (route: MeshMachineRoute): Promise<void> => {
        try {
          const info = await probeSlots.run(probes.signal, () =>
            boundedMeshOperation(
              (probeSignal) => input.probe(route, probeSignal),
              probes.signal,
              route.kind === 'private' ? 1_000 : 2_000,
            ),
          );
          if (!probes.signal.aborted) ready.push({ route, info });
        } catch (error) {
          lastError = error;
        } finally {
          remaining -= 1;
          wake?.();
        }
      };
      // Reserve the third lane for fallback, even when every preferred address blackholes.
      const preferredWorker = async (): Promise<void> => {
        while (!probes.signal.aborted) {
          const route = preferred.shift();
          if (route !== undefined) {
            await probe(route);
            continue;
          }
          await gate;
          const next = fallback.shift();
          if (next === undefined) return;
          await probe(next);
        }
      };
      const fallbackWorker = async (): Promise<void> => {
        await gate;
        while (!probes.signal.aborted) {
          const route = fallback.shift() ?? preferred.shift();
          if (route === undefined) return;
          await probe(route);
        }
      };
      const workers = [preferredWorker(), preferredWorker(), fallbackWorker()];
      try {
        while (!signal.aborted) {
          ready.sort((a, b) => meshMachineRouteRank(a.route) - meshMachineRouteRank(b.route));
          const candidate = ready.shift();
          if (candidate === undefined) {
            if (remaining === 0) break;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = undefined;
            continue;
          }
          try {
            return await authenticationSlots.run(signal, () =>
              boundedMeshOperation(
                (authSignal) => input.connect(candidate.route, candidate.info, authSignal),
                signal,
                MESH_ROUTE_AUTH_TIMEOUT_MS,
                input.dispose,
              ),
            );
          } catch (error) {
            authenticationError = error;
          }
        }
        if (signal.aborted) throw cancelled(signal);
        throw authenticationError ?? lastError;
      } finally {
        signal.removeEventListener('abort', abortProbes);
        if (gateTimer !== undefined) clearTimeout(gateTimer);
        probes.abort();
        openGate();
        // Every worker handles its errors. Late probe results cannot start authentication.
        void Promise.all(workers);
      }
    },
    outer,
    input.timeoutMs ?? MESH_ROUTE_CONNECT_BUDGET_MS,
    input.dispose,
  );
}

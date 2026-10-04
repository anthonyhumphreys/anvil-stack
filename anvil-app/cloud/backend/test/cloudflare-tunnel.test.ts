import { describe, expect, it } from 'vitest';

import { CloudflareTunnelError, CloudflareTunnelProvider } from '../src/hosted/cloudflare-tunnel';

const tunnelId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const dnsRecordId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const hostname = 'host-0123456789abcdef01234567.mesh.example.test';
const tunnelName = 'anvil-host-0123456789abcdef01234567-g1';
const operationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const connectorToken = 'eyJ0ZXN0LXR1bm5lbC1jcmVkZW50aWFsLXNlY3JldC1zdHJpbmcifQ==';

function response(result: unknown, status = 200): Response {
  return Response.json({ success: status < 400, result }, { status });
}

function provider(fetch: typeof globalThis.fetch): CloudflareTunnelProvider {
  return new CloudflareTunnelProvider({
    accountId: 'cloudflare-account',
    zoneId: 'cloudflare-zone',
    apiToken: 'cloudflare-api-token-test-value',
    publicDomain: 'mesh.example.test',
    localService: 'http://127.0.0.1:47631',
    apiBaseUrl: 'https://cloudflare.test/client/v4',
    fetch,
  });
}

describe('Cloudflare managed tunnel adapter', () => {
  it('reconciles a tunnel create whose response was lost without creating a duplicate', async () => {
    let tunnelExists = false;
    let createCalls = 0;
    let dnsExists = false;
    let configuredIngress: unknown;
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const request = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input.toString());
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null;
      calls.push({ method, path: url.pathname + url.search, body });
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer cloudflare-api-token-test-value');

      if (url.pathname.endsWith('/cfd_tunnel') && method === 'GET') {
        return response(tunnelExists ? [{ id: tunnelId, name: tunnelName, deleted_at: null }] : []);
      }
      if (url.pathname.endsWith('/cfd_tunnel') && method === 'POST') {
        createCalls += 1;
        tunnelExists = true;
        // Model a successful remote create followed by a lost HTTP response.
        return response({ error: 'response lost' }, 503);
      }
      if (url.pathname.endsWith(`/cfd_tunnel/${tunnelId}/configurations`) && method === 'PUT') {
        configuredIngress = (body as { config?: { ingress?: unknown } }).config?.ingress;
        return response({});
      }
      if (url.pathname.endsWith('/dns_records') && method === 'GET') {
        return response(dnsExists ? [{ id: dnsRecordId, type: 'CNAME', name: hostname, content: `${tunnelId}.cfargotunnel.com` }] : []);
      }
      if (url.pathname.endsWith('/dns_records') && method === 'POST') {
        dnsExists = true;
        return response({ id: dnsRecordId });
      }
      if (url.pathname.endsWith(`/cfd_tunnel/${tunnelId}/token`) && method === 'GET') {
        return response(connectorToken);
      }
      throw new Error(`unexpected Cloudflare API request: ${method} ${url.pathname}`);
    };

    const tunnels = provider(request as typeof fetch);
    await expect(tunnels.ensure({
      stableName: tunnelName,
      stableHostLabel: 'host-0123456789abcdef01234567',
      operationId,
      localService: 'http://127.0.0.1:43127',
    })).rejects.toMatchObject({ retryable: true });

    const allocation = await tunnels.ensure({
      stableName: tunnelName,
      stableHostLabel: 'host-0123456789abcdef01234567',
      operationId,
      localService: 'http://127.0.0.1:43127',
    });
    expect(allocation).toEqual({ tunnelId, connectorToken, dnsRecordId, hostname });
    expect(createCalls).toBe(1);
    expect(calls.filter((call) => call.method === 'POST' && call.path.endsWith('/cfd_tunnel'))).toHaveLength(1);
    expect(calls.filter((call) => call.method === 'PUT' && call.path.endsWith('/configurations'))).toHaveLength(1);
    expect(configuredIngress).toEqual([
      {
        hostname,
        service: 'http://127.0.0.1:43127',
        originRequest: { httpHostHeader: hostname },
      },
      { service: 'http_status:404' },
    ]);
    expect(JSON.stringify(calls)).not.toContain(connectorToken);
  });

  it('rejects non-loopback origins and fails without exposing provider response text', async () => {
    expect(() => new CloudflareTunnelProvider({
      accountId: 'cloudflare-account',
      zoneId: 'cloudflare-zone',
      apiToken: 'cloudflare-api-token-test-value',
      publicDomain: 'mesh.example.test',
      localService: 'https://attacker.example/path',
      fetch: async () => response({}),
    })).toThrow('invalid managed endpoint origin');

    const failing = provider(async () => new Response('provider leaked secret body', { status: 403 }));
    let error: unknown;
    try {
      await failing.ensure({ stableName: tunnelName, stableHostLabel: 'host-0123456789abcdef01234567', operationId });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CloudflareTunnelError);
    expect(error).toMatchObject({ retryable: false, status: 403 });
    expect((error as Error).message).not.toContain('provider leaked secret body');
  });
});

export interface CloudflareTunnelConfig {
  accountId: string;
  zoneId: string;
  apiToken: string;
  publicDomain: string;
  localService?: string;
  fetch?: typeof fetch;
  apiBaseUrl?: string;
}

export interface CloudflareTunnelAllocation {
  tunnelId: string;
  connectorToken: string;
  dnsRecordId: string;
  hostname: string;
}

interface CloudflareEnvelope<T> {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: T;
}

interface TunnelRecord {
  id?: string;
  name?: string;
  deleted_at?: string | null;
}

interface DnsRecord {
  id?: string;
  type?: string;
  name?: string;
  content?: string;
}

/** Provider API failures retain retryability without exposing response bodies or credentials. */
export class CloudflareTunnelError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'CloudflareTunnelError';
  }
}

/**
 * Cloudflare API adapter for one-host/one-generation remotely managed tunnels.
 * `fetch` is injected so tests cannot make an accidental public network call.
 * API paths are fixed; no caller supplied URL is fetched.
 */
export class CloudflareTunnelProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly apiBaseUrl: string;
  private readonly domain: string;
  private readonly defaultLocalService: string | null;

  constructor(private readonly config: CloudflareTunnelConfig) {
    this.fetchImpl = config.fetch ?? fetch;
    this.apiBaseUrl = (config.apiBaseUrl ?? 'https://api.cloudflare.com/client/v4').replace(/\/$/, '');
    this.domain = validateDomain(config.publicDomain);
    this.defaultLocalService = config.localService === undefined
      ? null
      : normalizeLoopbackService(config.localService);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(config.accountId)) {
      throw new Error('invalid Cloudflare account configuration');
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(config.zoneId)) {
      throw new Error('invalid Cloudflare zone configuration');
    }
    if (config.apiToken.length < 20) {
      throw new Error('invalid Cloudflare tunnel configuration');
    }
  }

  hostnameFor(stableHostLabel: string): string {
    if (!/^[a-z0-9-]{8,48}$/.test(stableHostLabel)) {
      throw new Error('invalid managed endpoint label');
    }
    return `${stableHostLabel}.${this.domain}`;
  }

  async ensure(input: {
    stableName: string;
    stableHostLabel: string;
    operationId: string;
    localService?: string;
  }): Promise<CloudflareTunnelAllocation> {
    if (!/^[a-z0-9-]{8,64}$/.test(input.stableName) || !/^[0-9a-f-]{36}$/.test(input.operationId)) {
      throw new Error('invalid tunnel operation');
    }
    const hostname = this.hostnameFor(input.stableHostLabel);
    const localService = input.localService === undefined
      ? this.defaultLocalService
      : normalizeLoopbackService(input.localService);
    if (localService === null) throw new Error('managed endpoint loopback origin is required');
    const tunnelId = await this.findOrCreateTunnel(input.stableName, input.operationId);
    await this.putConfiguration(tunnelId, hostname, localService);
    const dnsRecordId = await this.ensureDnsRecord(hostname, `${tunnelId}.cfargotunnel.com`);
    const connectorToken = await this.readTunnelToken(tunnelId);
    return { tunnelId, connectorToken, dnsRecordId, hostname };
  }

  async remove(input: { tunnelId: string; dnsRecordId: string }): Promise<void> {
    // Remove public DNS first. If the tunnel is still connected Cloudflare can
    // reject deletion; a later reconciliation retries the same two idempotent steps.
    await this.deleteDnsRecord(input.dnsRecordId);
    const path = `/accounts/${encodeURIComponent(this.config.accountId)}/cfd_tunnel/${encodeURIComponent(input.tunnelId)}`;
    const response = await this.call('DELETE', path);
    if (response.status === 404) return;
    await this.expectOk(response, 'delete tunnel');
  }

  async removeByName(input: { stableName: string; stableHostLabel: string }): Promise<void> {
    const hostname = this.hostnameFor(input.stableHostLabel);
    const tunnelId = await this.findTunnel(input.stableName);
    const dnsId = await this.findDnsRecordId(hostname);
    if (dnsId !== null) await this.deleteDnsRecord(dnsId);
    if (tunnelId !== null) {
      const response = await this.call(
        'DELETE',
        `/accounts/${encodeURIComponent(this.config.accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}`,
      );
      if (response.status !== 404) await this.expectOk(response, 'delete tunnel');
    }
  }

  async findTunnel(stableName: string): Promise<string | null> {
    const query = new URLSearchParams({ name: stableName, is_deleted: 'false', per_page: '100' });
    const response = await this.call(
      'GET',
      `/accounts/${encodeURIComponent(this.config.accountId)}/cfd_tunnel?${query.toString()}`,
    );
    await this.expectOk(response, 'list tunnels');
    const envelope = (await response.json()) as CloudflareEnvelope<TunnelRecord[]>;
    const matches = (Array.isArray(envelope.result) ? envelope.result : []).filter(
      (record) => record.name === stableName && record.deleted_at == null && isUuid(record.id),
    );
    if (matches.length > 1) {
      throw new CloudflareTunnelError('multiple tunnels match allocation operation', false);
    }
    return matches[0]?.id ?? null;
  }

  private async findOrCreateTunnel(stableName: string, operationId: string): Promise<string> {
    // Deterministic names let retries reconcile a create whose HTTP response
    // was lost. The caller persists operationId before invoking this method.
    const existing = await this.findTunnel(stableName);
    if (existing !== null) return existing;
    const response = await this.call(
      'POST',
      `/accounts/${encodeURIComponent(this.config.accountId)}/cfd_tunnel`,
      {
        name: stableName,
        config_src: 'cloudflare',
        metadata: { anvil_operation_id: operationId },
      },
    );
    await this.expectOk(response, 'create tunnel');
    const envelope = (await response.json()) as CloudflareEnvelope<TunnelRecord>;
    if (!isUuid(envelope.result?.id)) {
      throw new CloudflareTunnelError('Cloudflare returned an invalid tunnel identity', true);
    }
    return envelope.result.id;
  }

  private async putConfiguration(tunnelId: string, hostname: string, localService: string): Promise<void> {
    const response = await this.call(
      'PUT',
      `/accounts/${encodeURIComponent(this.config.accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`,
      {
        config: {
          ingress: [
            {
              hostname,
              service: localService,
              originRequest: { httpHostHeader: hostname },
            },
            { service: 'http_status:404' },
          ],
        },
      },
    );
    await this.expectOk(response, 'configure tunnel');
  }

  private async ensureDnsRecord(hostname: string, tunnelTarget: string): Promise<string> {
    const query = new URLSearchParams({ name: hostname, type: 'CNAME', per_page: '100' });
    const list = await this.call(
      'GET',
      `/zones/${encodeURIComponent(this.config.zoneId)}/dns_records?${query.toString()}`,
    );
    await this.expectOk(list, 'list DNS records');
    const listEnvelope = (await list.json()) as CloudflareEnvelope<DnsRecord[]>;
    const matching = (Array.isArray(listEnvelope.result) ? listEnvelope.result : []).filter(
      (record) => record.type === 'CNAME' && record.name === hostname && isUuid(record.id),
    );
    if (matching.length > 1) {
      throw new CloudflareTunnelError('multiple DNS records match allocation hostname', false);
    }
    const existing = matching[0];
    if (existing?.id && existing.content === tunnelTarget) return existing.id;
    if (existing?.id) {
      const updated = await this.call(
        'PUT',
        `/zones/${encodeURIComponent(this.config.zoneId)}/dns_records/${encodeURIComponent(existing.id)}`,
        { type: 'CNAME', name: hostname, content: tunnelTarget, proxied: true, ttl: 1 },
      );
      await this.expectOk(updated, 'update DNS record');
      return existing.id;
    }
    const created = await this.call(
      'POST',
      `/zones/${encodeURIComponent(this.config.zoneId)}/dns_records`,
      { type: 'CNAME', name: hostname, content: tunnelTarget, proxied: true, ttl: 1 },
    );
    await this.expectOk(created, 'create DNS record');
    const createdEnvelope = (await created.json()) as CloudflareEnvelope<DnsRecord>;
    if (!isUuid(createdEnvelope.result?.id)) {
      throw new CloudflareTunnelError('Cloudflare returned an invalid DNS identity', true);
    }
    return createdEnvelope.result.id;
  }

  private async findDnsRecordId(hostname: string): Promise<string | null> {
    const query = new URLSearchParams({ name: hostname, type: 'CNAME', per_page: '100' });
    const response = await this.call(
      'GET',
      `/zones/${encodeURIComponent(this.config.zoneId)}/dns_records?${query.toString()}`,
    );
    await this.expectOk(response, 'list DNS records');
    const envelope = (await response.json()) as CloudflareEnvelope<DnsRecord[]>;
    const matches = (Array.isArray(envelope.result) ? envelope.result : []).filter(
      (record) => record.type === 'CNAME' && record.name === hostname && isUuid(record.id),
    );
    if (matches.length > 1) {
      throw new CloudflareTunnelError('multiple DNS records match allocation hostname', false);
    }
    return matches[0]?.id ?? null;
  }

  async readTunnelToken(tunnelId: string): Promise<string> {
    const response = await this.call(
      'GET',
      `/accounts/${encodeURIComponent(this.config.accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/token`,
    );
    await this.expectOk(response, 'read tunnel token');
    const envelope = (await response.json()) as CloudflareEnvelope<string>;
    if (typeof envelope.result !== 'string' || envelope.result.length < 40 || envelope.result.length > 8_192) {
      throw new CloudflareTunnelError('Cloudflare returned an invalid tunnel credential', false);
    }
    return envelope.result;
  }

  private async deleteDnsRecord(recordId: string): Promise<void> {
    if (!isUuid(recordId)) throw new Error('invalid DNS record identity');
    const response = await this.call(
      'DELETE',
      `/zones/${encodeURIComponent(this.config.zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
    );
    if (response.status === 404) return;
    await this.expectOk(response, 'delete DNS record');
  }

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.config.apiToken}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new CloudflareTunnelError('Cloudflare API request failed', true);
    }
  }

  private async expectOk(response: Response, action: string): Promise<void> {
    if (response.ok) return;
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw new CloudflareTunnelError(`Cloudflare could not ${action}`, retryable, response.status);
  }
}

function validateDomain(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, '');
  if (
    normalized.length > 220 ||
    normalized.length < 3 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(normalized)
  ) {
    throw new Error('invalid managed endpoint domain');
  }
  return normalized;
}

export function normalizeLoopbackService(value: string): string {
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    !loopback ||
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    !Number.isInteger(Number(url.port)) ||
    Number(url.port) < 1 ||
    Number(url.port) > 65_535
  ) {
    throw new Error('invalid managed endpoint origin');
  }
  return `${url.protocol}//${url.host}`;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

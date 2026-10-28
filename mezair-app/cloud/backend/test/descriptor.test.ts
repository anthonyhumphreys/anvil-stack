import { describe, expect, it } from 'vitest';

import { buildDescriptor } from '../src/descriptor';
import { WORKOS_AUTHKIT_ISSUER } from '../../contract/auth';

describe('backend discovery descriptor', () => {
  it('advertises share audiences only with organization identity and a configured signed viewer channel', () => {
    const complete = {
      HOSTED_DB: {},
      HOSTED_WORKOS_CLIENT_ID: 'client_website',
      HOSTED_SERVICE_KEYS: JSON.stringify({ viewer: 'a'.repeat(32) }),
      OIDC_ISSUER: WORKOS_AUTHKIT_ISSUER,
      OIDC_CLIENT_ID: 'client_desktop',
    };
    expect(buildDescriptor(complete).features).toContain('share-audiences/1');
    expect(buildDescriptor().features).not.toContain('share-audiences/1');
    for (const partial of [
      { ...complete, HOSTED_DB: undefined },
      { ...complete, HOSTED_WORKOS_CLIENT_ID: undefined },
      { ...complete, HOSTED_SERVICE_KEYS: undefined },
      { ...complete, HOSTED_SERVICE_KEYS: '{broken' },
      { ...complete, HOSTED_SERVICE_KEYS: JSON.stringify({ viewer: 'short' }) },
      { ...complete, OIDC_ISSUER: 'https://other.example' },
    ])
      expect(buildDescriptor(partial).features).not.toContain('share-audiences/1');
  });

  it('advertises worker capability requirement enforcement for Mesh jobs', () => {
    expect(buildDescriptor().features).toContain('mesh-job-capability-requirements/1');
  });

  it('advertises WorkOS device authorization only for the fixed AuthKit issuer', () => {
    const descriptor = buildDescriptor({
      OIDC_ISSUER: WORKOS_AUTHKIT_ISSUER,
      OIDC_CLIENT_ID: 'client_mezair_public',
    });
    expect(descriptor.authModes).toEqual(['oidc-pkce', 'workos-device']);
  });

  it('does not advertise device authorization for another OIDC authority', () => {
    const descriptor = buildDescriptor({
      OIDC_ISSUER: 'https://issuer.example',
      OIDC_CLIENT_ID: 'client_mezair_public',
    });
    expect(descriptor.authModes).toEqual(['enrollment-code', 'oidc-pkce']);
  });

  it('does not advertise device authorization for a trailing-slash variant', () => {
    const descriptor = buildDescriptor({
      OIDC_ISSUER: `${WORKOS_AUTHKIT_ISSUER}/`,
      OIDC_CLIENT_ID: 'client_mezair_public',
    });
    expect(descriptor.authModes).toEqual(['enrollment-code', 'oidc-pkce']);
  });

  it('omits human enrollment codes for hosted deployments', () => {
    const descriptor = buildDescriptor({
      HOSTED_DB: {},
      OIDC_ISSUER: 'https://issuer.example',
      OIDC_CLIENT_ID: 'client_mezair_public',
    });
    expect(descriptor.authModes).toEqual(['oidc-pkce']);
  });

  it('does not advertise human codes for a partial WorkOS configuration', () => {
    const descriptor = buildDescriptor({
      OIDC_ISSUER: 'https://API.WORKOS.COM/user_management',
    });
    expect(descriptor.authModes).toEqual([]);
  });
});

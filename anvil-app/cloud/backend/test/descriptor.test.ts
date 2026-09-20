import { describe, expect, it } from 'vitest';

import { buildDescriptor } from '../src/descriptor';
import { WORKOS_AUTHKIT_ISSUER } from '../../contract/auth';

describe('backend discovery descriptor', () => {
  it('advertises WorkOS device authorization only for the fixed AuthKit issuer', () => {
    const descriptor = buildDescriptor({
      OIDC_ISSUER: WORKOS_AUTHKIT_ISSUER,
      OIDC_CLIENT_ID: 'client_anvil_public',
    });
    expect(descriptor.authModes).toEqual([
      'enrollment-code',
      'oidc-pkce',
      'workos-device',
    ]);
  });

  it('does not advertise device authorization for another OIDC authority', () => {
    const descriptor = buildDescriptor({
      OIDC_ISSUER: 'https://issuer.example',
      OIDC_CLIENT_ID: 'client_anvil_public',
    });
    expect(descriptor.authModes).toEqual(['enrollment-code', 'oidc-pkce']);
  });

  it('does not advertise device authorization for a trailing-slash variant', () => {
    const descriptor = buildDescriptor({
      OIDC_ISSUER: `${WORKOS_AUTHKIT_ISSUER}/`,
      OIDC_CLIENT_ID: 'client_anvil_public',
    });
    expect(descriptor.authModes).toEqual(['enrollment-code', 'oidc-pkce']);
  });
});

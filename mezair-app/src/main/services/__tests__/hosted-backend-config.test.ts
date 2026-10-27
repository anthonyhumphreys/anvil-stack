import { describe, expect, it } from 'vitest';
import { resolveHostedBackendUrl } from '../hosted-backend-config';

describe('resolveHostedBackendUrl', () => {
  it('defaults an absent environment to staging and supports the legacy URL there', () => {
    expect(
      resolveHostedBackendUrl({
        deploymentEnv: undefined,
        stagingUrl: '',
        productionUrl: 'https://production.example.test',
        legacyUrl: 'https://legacy.example.test/base',
      }),
    ).toBe('https://legacy.example.test/base/');
  });

  it('prefers the staging URL when the deployment environment is staging', () => {
    expect(
      resolveHostedBackendUrl({
        deploymentEnv: 'staging',
        stagingUrl: 'https://staging.example.test',
        productionUrl: 'https://production.example.test',
        legacyUrl: 'https://legacy.example.test',
      }),
    ).toBe('https://staging.example.test/');
  });

  it('uses the deployment-specific URL and ignores staging URLs in production', () => {
    expect(
      resolveHostedBackendUrl({
        deploymentEnv: 'production',
        stagingUrl: 'https://staging.example.test',
        productionUrl: 'https://production.example.test',
        legacyUrl: 'https://legacy.example.test',
      }),
    ).toBe('https://production.example.test/');
  });

  it('does not fall back from a missing production URL to staging or legacy', () => {
    expect(
      resolveHostedBackendUrl({
        deploymentEnv: 'production',
        stagingUrl: 'https://staging.example.test',
        productionUrl: undefined,
        legacyUrl: 'https://legacy.example.test',
      }),
    ).toBeNull();
  });

  it('fails closed for invalid environments and non-HTTPS hosted URLs', () => {
    const configuration = {
      deploymentEnv: 'staging',
      stagingUrl: 'http://staging.example.test',
      productionUrl: undefined,
      legacyUrl: undefined,
    };

    expect(resolveHostedBackendUrl({ ...configuration, deploymentEnv: 'preview' })).toBeNull();
    expect(resolveHostedBackendUrl({ ...configuration, deploymentEnv: ' ' })).toBeNull();
    expect(resolveHostedBackendUrl(configuration)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';

import { selfHostAccountPage } from '../src/account-page';

describe('self-host account page', () => {
  it('contains operator flows without embedding a credential', async () => {
    const response = selfHostAccountPage();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const html = await response.text();
    expect(html).toContain('Issue enrollment code');
    expect(html).toContain('/v1/enrollment-codes');
    expect(html).toContain('device.list');
    expect(html).toContain('expiresAt');
    expect(html).not.toContain('ENROLLMENT_ADMIN_TOKEN');
  });
});

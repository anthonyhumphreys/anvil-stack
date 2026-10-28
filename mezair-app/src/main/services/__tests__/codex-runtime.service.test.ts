import { describe, expect, it } from 'vitest';
import {
  MINIMUM_CODEX_VERSION,
  MANAGED_CODEX_VERSION,
  getCodexRuntimeTarget,
  getManagedCodexExecutablePath,
  isSupportedCodexVersion,
} from '../codex-runtime.service.js';

describe('Codex runtime metadata', () => {
  it('pins a stable official release and a platform archive', () => {
    expect(MANAGED_CODEX_VERSION).toBe('0.154.0');
    expect(MINIMUM_CODEX_VERSION).toBe('0.154.0');
    expect(getCodexRuntimeTarget()).toMatchObject({
      archive: expect.stringMatching(/^codex-package-.+\.tar\.gz$/),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('requires a validated version range and preserves the release bin layout', () => {
    expect(isSupportedCodexVersion('0.150.9')).toBe(false);
    expect(isSupportedCodexVersion('0.151.0')).toBe(false);
    expect(isSupportedCodexVersion('0.154.0')).toBe(true);
    expect(isSupportedCodexVersion('0.155.0')).toBe(false);
    expect(getManagedCodexExecutablePath('/user-data/codex-runtime')).toMatch(
      /\/0\.154\.0\/bin\/codex$/,
    );
  });
});

import { describe, expect, it } from 'vitest';
import type { ShareRecord } from '../../../../shared/shares-ipc';
import { errorMessage, isShareBehind, isShareExpired, shareStatusLine } from '../share-format';

function record(overrides: Partial<ShareRecord> = {}): ShareRecord {
  return {
    id: 'r1',
    itemType: 'artifact',
    itemId: 'a1',
    version: 2,
    shareId: 'shr_1',
    title: 'Notes',
    mediaType: 'text/markdown',
    interactive: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('share-format', () => {
  const now = new Date('2026-03-01T00:00:00.000Z');

  it('says when the item has moved on', () => {
    expect(shareStatusLine(record({ currentVersion: 4 }), now)).toBe("Shared v2 · you're on v4");
    expect(isShareBehind(record({ currentVersion: 2 }))).toBe(false);
  });

  it('shows expiry otherwise', () => {
    expect(shareStatusLine(record({ expiresAt: '2026-11-12T00:00:00.000Z' }), now)).toMatch(
      /^Shared v2 · expires /,
    );
    expect(shareStatusLine(record({ expiresAt: '2026-02-01T00:00:00.000Z' }), now)).toBe(
      'Shared v2 · expired',
    );
    expect(isShareExpired(record({ expiresAt: '2026-02-01T00:00:00.000Z' }), now.getTime())).toBe(
      true,
    );
  });

  it('strips the Electron IPC prefix from errors', () => {
    expect(
      errorMessage(
        new Error("Error invoking remote method 'shares:publish': Error: Sharing is blocked"),
      ),
    ).toBe('Sharing is blocked');
  });
});

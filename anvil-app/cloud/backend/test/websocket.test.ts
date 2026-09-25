import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { SyncPushResult } from '../../contract/sync';
import {
  expectSuccess,
  hashedChange,
  nextFrameOfType,
  postRpc,
  spikeBearer,
  uniqueIds,
} from './helpers';

describe('live channel', () => {
  it('delivers sync.invalidate after an accepted push', async () => {
    const ids = uniqueIds('ws-invalidate');
    const auth = spikeBearer(ids.accountId, ids.enrollmentId);
    const upgrade = await SELF.fetch('https://spike.test/v1/connect', {
      headers: {
        Upgrade: 'websocket',
        Authorization: auth,
      },
    });
    expect(upgrade.status).toBe(101);
    const socket = upgrade.webSocket;
    if (socket == null) {
      throw new Error('expected hibernatable WebSocket');
    }
    socket.accept();

    // The session `hello` opens every socket — wait past it for the
    // invalidate frame.
    const invalidated = nextFrameOfType(socket, 'sync.invalidate');

    const change = await hashedChange({
      enrollmentSequence: 1,
      entityId: 'ws-live',
      payload: { name: 'Live' },
    });
    const pushed = expectSuccess<SyncPushResult>(
      await postRpc('sync.push', { changes: [change] }, auth),
    );
    expect(pushed.results[0]?.status).toBe('accepted');

    const frame = (await invalidated) as {
      type: string;
      version: number;
      epoch: string;
      watermark: number;
    };
    expect(frame.type).toBe('sync.invalidate');
    expect(frame.version).toBe(1);
    expect(frame.epoch).toBe('spike-epoch-1');
    expect(frame.watermark).toBe(1);
    socket.close(1000, 'done');
  });
});

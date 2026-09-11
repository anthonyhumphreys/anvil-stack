import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { SyncPushResult } from '../../contract/sync';
import { expectSuccess, hashedChange, postRpc, spikeBearer, uniqueIds } from './helpers';

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

    const invalidated = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('invalidate frame timed out')), 5_000);
      socket.addEventListener('message', (event) => {
        clearTimeout(timer);
        resolve(String(event.data));
      });
    });

    const change = await hashedChange({
      enrollmentSequence: 1,
      entityId: 'ws-live',
      payload: { name: 'Live' },
    });
    const pushed = expectSuccess<SyncPushResult>(
      await postRpc('sync.push', { changes: [change] }, auth),
    );
    expect(pushed.results[0]?.status).toBe('accepted');

    const frame = JSON.parse(await invalidated) as {
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

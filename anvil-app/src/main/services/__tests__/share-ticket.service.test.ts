import { SCHEMA_SQL } from '../../db/schema.js';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = new Database(':memory:');
db.exec(SCHEMA_SQL);
const mocks = vi.hoisted(() => ({
  settings: {
    workItemConnections: [] as Array<{ id: string; provider: string; [key: string]: unknown }>,
  },
  item: {
    id: 'ANV-4',
    provider: 'linear',
    title: 'Thread sharing',
    type: 'Task',
    state: 'Todo',
    priority: 2,
  },
  getItem: vi.fn(),
  publishLink: vi.fn(),
  postCount: 0,
}));
vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('../settings.service.js', () => ({ getSettings: () => mocks.settings }));
vi.mock('../workitem-provider.js', () => ({
  getActiveProvider: () => ({ getItem: mocks.getItem, publishLink: mocks.publishLink }),
}));

import {
  attachShareToTicket,
  getShareTicketReceipt,
  previewShareTicket,
} from '../share-ticket.service.js';
import type { WorkItemReference } from '../../../shared/change-review-types.js';

const ref: WorkItemReference = { connectionId: 'conn-a', provider: 'linear', id: 'ANV-4' };
const input = {
  shareRecordId: 'share-1',
  url: 'https://share.test/s/abc#k=secret',
  title: 'Design review',
  audienceLabel: 'Anyone with the link',
  sharedAt: '2026-10-25T12:00:00.000Z',
};

describe('share-ticket.service', () => {
  beforeEach(() => {
    db.exec('DELETE FROM share_ticket_publications');
    mocks.settings = { workItemConnections: [{ id: 'conn-a', provider: 'linear' }] };
    mocks.getItem.mockReset().mockResolvedValue(mocks.item);
    mocks.postCount = 0;
    mocks.publishLink.mockReset().mockImplementation(async (_id, _input, beforePost) => {
      await beforePost?.();
      mocks.postCount += 1;
    });
  });

  it('previews the exact resolved target and a concise audience/date comment', async () => {
    const result = await previewShareTicket(ref, input);
    expect(result).toEqual({
      connectionId: 'conn-a',
      provider: 'linear',
      ticketId: 'ANV-4',
      ticketTitle: 'Thread sharing',
      commentPreview:
        'Anvil thread shared: Design review\nAudience: Anyone with the link\nShared: 2026-10-25\nLink: [Design review]',
    });
    expect(JSON.stringify(result)).not.toContain('#k=secret');
  });

  it('checks provider identity, posts once, and persists a URL-free published receipt', async () => {
    const receipt = await attachShareToTicket(ref, input);
    expect(receipt.status).toBe('published');
    expect(mocks.publishLink).toHaveBeenCalledTimes(1);
    expect(mocks.publishLink).toHaveBeenCalledWith(
      'ANV-4',
      {
        text: 'Anvil thread shared: Design review\nAudience: Anyone with the link\nShared: 2026-10-25',
        label: 'Design review',
        url: input.url,
      },
      expect.any(Function),
    );
    expect(JSON.stringify(receipt)).not.toContain('#k=secret');
    expect(getShareTicketReceipt(ref, 'share-1')).toEqual(receipt);
    expect(await attachShareToTicket(ref, input)).toEqual(receipt);
    expect(mocks.publishLink).toHaveBeenCalledTimes(1);
  });

  it('retains uncertain outcomes and blocks automatic duplicate posts', async () => {
    mocks.publishLink.mockRejectedValueOnce(new Error(`network failed ${input.url}`));
    await expect(attachShareToTicket(ref, input)).rejects.toThrow(/outcome is uncertain/);
    expect(getShareTicketReceipt(ref, 'share-1')?.status).toBe('uncertain');
    await expect(attachShareToTicket(ref, input)).rejects.toThrow(/Check the ticket/);
    expect(mocks.publishLink).toHaveBeenCalledTimes(1);
  });

  it('rejects a connection whose configured provider differs from the selected reference', async () => {
    mocks.settings = { workItemConnections: [{ id: 'conn-a', provider: 'jira' }] };
    await expect(previewShareTicket(ref, input)).rejects.toThrow(/different provider/);
    expect(mocks.getItem).not.toHaveBeenCalled();
  });

  it('pins the configured connection and blocks posting if it changes during ticket lookup', async () => {
    mocks.getItem.mockImplementationOnce(async () => {
      mocks.settings = {
        workItemConnections: [{ id: 'conn-a', provider: 'linear', linearApiKey: 'rotated' }],
      };
      return mocks.item;
    });
    await expect(attachShareToTicket(ref, input)).rejects.toThrow(
      /connection changed before publication/,
    );
    expect(mocks.postCount).toBe(0);
    expect(getShareTicketReceipt(ref, 'share-1')).toBeUndefined();
  });

  it('runs the share-liveness callback before posting and clears pending intent if it fails', async () => {
    const beforePost = vi.fn().mockRejectedValue(new Error('share revoked'));
    await expect(attachShareToTicket(ref, input, beforePost)).rejects.toThrow(
      /share or Work Item connection changed before publication/,
    );
    expect(beforePost).toHaveBeenCalledTimes(1);
    expect(mocks.postCount).toBe(0);
    expect(getShareTicketReceipt(ref, 'share-1')).toBeUndefined();
  });

  it('rechecks the connection after an asynchronous share-liveness callback', async () => {
    const beforePost = vi.fn(async () => {
      await Promise.resolve();
      mocks.settings = {
        workItemConnections: [{ id: 'conn-a', provider: 'linear', linearApiKey: 'rotated' }],
      };
    });
    await expect(attachShareToTicket(ref, input, beforePost)).rejects.toThrow(
      /connection changed before publication/,
    );
    expect(beforePost).toHaveBeenCalledTimes(1);
    expect(mocks.postCount).toBe(0);
    expect(getShareTicketReceipt(ref, 'share-1')).toBeUndefined();
  });
});

it('persists a GitHub publication in the real schema', async () => {
  const id = `https://${'enterprise.'.repeat(15)}example.com/acme/widgets/issues/42`;
  mocks.settings = { workItemConnections: [{ id: 'github', provider: 'github' }] };
  mocks.getItem.mockResolvedValue({ ...mocks.item, id, provider: 'github' });
  mocks.publishLink.mockImplementation(async (_id, _input, guard) => {
    await guard?.();
  });
  const receipt = await attachShareToTicket(
    { connectionId: 'github', provider: 'github', id },
    { ...input, shareRecordId: 'github-share' },
  );
  expect(receipt.status).toBe('published');
  expect(receipt.provider).toBe('github');
});

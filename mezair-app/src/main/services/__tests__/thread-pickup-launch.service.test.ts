import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import {
  deliverPendingThreadPickup,
  hasPendingThreadPickup,
  isThreadPickupUrl,
  queueThreadPickup,
  queueThreadPickupFromArgv,
  takePendingThreadPickupFile,
} from '../thread-pickup-launch.service.js';

beforeEach(() => {
  takePendingThreadPickupFile();
});

describe('thread pickup launch', () => {
  it('opens the import flow without putting conversation data or keys in a URL', () => {
    expect(isThreadPickupUrl('mezair://pick-up-thread')).toBe(true);
    expect(isThreadPickupUrl('devhub://pick-up-thread/')).toBe(true);
    for (const url of [
      'mezair://pick-up-thread?file=/private/source',
      'mezair://pick-up-thread#k=secret',
      'mezair://user:secret@pick-up-thread',
      'mezair://pick-up-thread:1234',
      'https://pick-up-thread',
      'mezair://pick-up-thread/other',
      'mezair://pick-up-thread.example',
      'not a URL',
    ])
      expect(isThreadPickupUrl(url)).toBe(false);
  });

  it('accepts only absolute package paths, and consumes a pending path once', () => {
    expect(queueThreadPickup('relative.mezair-thread')).toBe(false);
    expect(queueThreadPickup('/tmp/other.json')).toBe(false);
    expect(queueThreadPickup('/tmp/bad\0.mezair-thread')).toBe(false);
    expect(queueThreadPickup('/tmp/shared.mezair-thread')).toBe(true);
    expect(hasPendingThreadPickup()).toBe(true);
    expect(takePendingThreadPickupFile()).toBe('/tmp/shared.mezair-thread');
    expect(hasPendingThreadPickup()).toBe(false);
    expect(takePendingThreadPickupFile()).toBeNull();
  });

  it('supports OS file argv and content-free protocol argv', () => {
    expect(queueThreadPickupFromArgv(['/app/Mezair', '/tmp/shared.mezair-thread'])).toBe(true);
    expect(takePendingThreadPickupFile()).toBe('/tmp/shared.mezair-thread');
    expect(queueThreadPickupFromArgv(['/app/Mezair', 'mezair://pick-up-thread'])).toBe(true);
    expect(hasPendingThreadPickup()).toBe(true);
    expect(takePendingThreadPickupFile()).toBeNull();
    expect(queueThreadPickupFromArgv(['/app/Mezair', '--file=/tmp/shared.mezair-thread'])).toBe(
      false,
    );
  });

  it('sends only an availability event to the renderer, never a source path or package', () => {
    const send = vi.fn();
    const window = { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow;
    deliverPendingThreadPickup(window);
    expect(send).not.toHaveBeenCalled();
    queueThreadPickup('/tmp/shared.mezair-thread');
    deliverPendingThreadPickup(window);
    expect(send).toHaveBeenCalledExactlyOnceWith('shares:pickup-requested');
  });
});

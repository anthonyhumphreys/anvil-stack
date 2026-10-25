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
    expect(isThreadPickupUrl('anvil://pick-up-thread')).toBe(true);
    expect(isThreadPickupUrl('devhub://pick-up-thread/')).toBe(true);
    for (const url of [
      'anvil://pick-up-thread?file=/private/source',
      'anvil://pick-up-thread#k=secret',
      'anvil://user:secret@pick-up-thread',
      'anvil://pick-up-thread:1234',
      'https://pick-up-thread',
      'anvil://pick-up-thread/other',
      'anvil://pick-up-thread.example',
      'not a URL',
    ])
      expect(isThreadPickupUrl(url)).toBe(false);
  });

  it('accepts only absolute package paths, and consumes a pending path once', () => {
    expect(queueThreadPickup('relative.anvil-thread')).toBe(false);
    expect(queueThreadPickup('/tmp/other.json')).toBe(false);
    expect(queueThreadPickup('/tmp/bad\0.anvil-thread')).toBe(false);
    expect(queueThreadPickup('/tmp/shared.anvil-thread')).toBe(true);
    expect(hasPendingThreadPickup()).toBe(true);
    expect(takePendingThreadPickupFile()).toBe('/tmp/shared.anvil-thread');
    expect(hasPendingThreadPickup()).toBe(false);
    expect(takePendingThreadPickupFile()).toBeNull();
  });

  it('supports OS file argv and content-free protocol argv', () => {
    expect(queueThreadPickupFromArgv(['/app/Anvil', '/tmp/shared.anvil-thread'])).toBe(true);
    expect(takePendingThreadPickupFile()).toBe('/tmp/shared.anvil-thread');
    expect(queueThreadPickupFromArgv(['/app/Anvil', 'anvil://pick-up-thread'])).toBe(true);
    expect(hasPendingThreadPickup()).toBe(true);
    expect(takePendingThreadPickupFile()).toBeNull();
    expect(queueThreadPickupFromArgv(['/app/Anvil', '--file=/tmp/shared.anvil-thread'])).toBe(
      false,
    );
  });

  it('sends only an availability event to the renderer, never a source path or package', () => {
    const send = vi.fn();
    const window = { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow;
    deliverPendingThreadPickup(window);
    expect(send).not.toHaveBeenCalled();
    queueThreadPickup('/tmp/shared.anvil-thread');
    deliverPendingThreadPickup(window);
    expect(send).toHaveBeenCalledExactlyOnceWith('shares:pickup-requested');
  });
});

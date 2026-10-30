import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openFactorySnapshotWithPrivateKey, sealFactorySnapshot } from '../factory-access.service';

function recipient(userId: string) {
  const pair = generateKeyPairSync('x25519');
  return {
    userId,
    privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer,
    publicKey: pair.publicKey
      .export({ format: 'der', type: 'spki' })
      .subarray(-32)
      .toString('base64'),
  };
}

describe('factory snapshot encryption', () => {
  it('round-trips to each enrolled recipient while keeping recipient envelopes isolated', () => {
    const first = recipient('workos_first'),
      second = recipient('workos_second');
    const payload = { id: 'factory_1', revision: 7, title: 'Private factory', nodes: ['plan'] };
    const sealed = sealFactorySnapshot(payload, 'factory_1', 7, [first, second]);

    expect(
      openFactorySnapshotWithPrivateKey(sealed, 'factory_1', 7, first.userId, first.privateKey),
    ).toEqual(payload);
    expect(
      openFactorySnapshotWithPrivateKey(sealed, 'factory_1', 7, second.userId, second.privateKey),
    ).toEqual(payload);
    expect(Object.keys(sealed.keys).sort()).toEqual(['workos_first', 'workos_second']);
  });

  it('rejects wrong recipient, factory identity, and revision', () => {
    const owner = recipient('workos_owner'),
      stranger = recipient('workos_stranger');
    const sealed = sealFactorySnapshot({ id: 'factory_2', revision: 3 }, 'factory_2', 3, [owner]);

    expect(() =>
      openFactorySnapshotWithPrivateKey(
        sealed,
        'factory_2',
        3,
        stranger.userId,
        stranger.privateKey,
      ),
    ).toThrow();
    expect(() =>
      openFactorySnapshotWithPrivateKey(sealed, 'factory_other', 3, owner.userId, owner.privateKey),
    ).toThrow();
    expect(() =>
      openFactorySnapshotWithPrivateKey(sealed, 'factory_2', 4, owner.userId, owner.privateKey),
    ).toThrow();
    const tampered = { ...sealed, ciphertext: `${sealed.ciphertext.slice(0, -4)}AAAA` };
    expect(() =>
      openFactorySnapshotWithPrivateKey(tampered, 'factory_2', 3, owner.userId, owner.privateKey),
    ).toThrow();
  });
});

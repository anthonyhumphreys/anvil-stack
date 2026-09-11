import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalChangeHashInput,
  hashChange,
} from '../../../../cloud/contract/sync';
import {
  canonicalChangeHashInput as sharedCanonicalInput,
  hashChange as sharedHashChange,
} from '../../../shared/sync-mesh';

const sha256Hex = (input: string): string =>
  createHash('sha256').update(input).digest('hex');

const change = {
  entityType: 'workflow-template',
  entityId: 'tmpl-1',
  schemaVersion: 1,
  baseRevision: 4,
  operation: 'update' as const,
  payload: { z: 1, a: { d: 2, b: 3 }, name: 'Draft' },
};

describe('local and contract PendingChange hashing', () => {
  it('produces the same canonical input and hash through both paths', () => {
    expect(sharedCanonicalInput(change)).toBe(canonicalChangeHashInput(change));
    expect(sharedHashChange(change, sha256Hex)).toBe(hashChange(change, sha256Hex));
  });

  it('is independent of payload key order', () => {
    const reordered = {
      ...change,
      payload: { name: 'Draft', a: { b: 3, d: 2 }, z: 1 },
    };
    expect(sharedHashChange(reordered, sha256Hex)).toBe(hashChange(change, sha256Hex));
  });
});

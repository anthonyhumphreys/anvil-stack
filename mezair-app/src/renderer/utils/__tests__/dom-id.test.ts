import { describe, expect, it } from 'vitest';
import { slugForDomId } from '../dom-id';

describe('slugForDomId', () => {
  it('keeps generated ids DOM-safe and stable', () => {
    expect(slugForDomId('src/components/Thing.tsx')).toBe('src-components-Thing-tsx');
    expect(slugForDomId(' repo 1 ')).toBe('repo-1');
  });

  it('falls back when a value has no usable id characters', () => {
    expect(slugForDomId('///')).toBe('item');
  });
});

import { describe, expect, it } from 'vitest';
import { parseCsv } from '../ArtifactPreview';

describe('parseCsv', () => {
  it('parses quoted commas, escaped quotes, and multiline cells', () => {
    expect(parseCsv('name,notes\nAnvil,"Useful, mostly"\nCanvas,"Said ""hello""\non two lines"')).toEqual([
      ['name', 'notes'],
      ['Anvil', 'Useful, mostly'],
      ['Canvas', 'Said "hello"\non two lines'],
    ]);
  });

  it('does not add a phantom row for a trailing newline', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

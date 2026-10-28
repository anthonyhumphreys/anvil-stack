import { describe, expect, it } from 'vitest';
import { extractFigmaRefs, formatFigmaRefsForPrompt } from '../figma-url';

describe('figma-url utilities', () => {
  it('extracts Figma Make links as Make project refs', () => {
    const [ref] = extractFigmaRefs(
      'Use https://www.figma.com/make/ABC123xyz/Popup-prototype?node-id=1-24 for this.',
    );

    expect(ref).toEqual(
      expect.objectContaining({
        kind: 'make',
        fileKey: 'ABC123xyz',
        url: 'https://www.figma.com/make/ABC123xyz/Popup-prototype?node-id=1-24',
        nodeId: '1:24',
      }),
    );
  });

  it('uses branch keys for branched Figma design URLs', () => {
    const [ref] = extractFigmaRefs(
      'https://www.figma.com/design/file123/branch/branch456/App?node-id=2-7',
    );

    expect(ref).toEqual(
      expect.objectContaining({
        kind: 'design',
        fileKey: 'branch456',
        nodeId: '2:7',
      }),
    );
  });

  it('adds Make-specific MCP resource guidance to prompt context', () => {
    const refs = extractFigmaRefs('https://figma.com/make/make123/App-prototype');

    expect(formatFigmaRefsForPrompt(refs)).toContain('Figma Make project');
    expect(formatFigmaRefsForPrompt(refs)).toContain('Figma MCP resources capability');
    expect(formatFigmaRefsForPrompt(refs)).toContain('List the available resources');
  });
});

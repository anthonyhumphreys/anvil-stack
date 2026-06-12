import { describe, it, expect } from 'vitest';
import { extractFindings, stripFindingMarkers, splitByFindings } from '../finding-parser.js';

describe('extractFindings', () => {
  it('extracts a single finding (type= syntax)', () => {
    const text = 'text before\n:::finding type=compliance\nGDPR concern.\n:::\ntext after';
    const result = extractFindings(text);
    expect(result).toEqual([{ type: 'compliance', content: 'GDPR concern.' }]);
  });

  it('extracts a single finding (bracket syntax)', () => {
    const text = 'text before\n:::finding[compliance]\nGDPR concern.\n:::\ntext after';
    const result = extractFindings(text);
    expect(result).toEqual([{ type: 'compliance', content: 'GDPR concern.' }]);
  });

  it('extracts multiple findings (type= syntax)', () => {
    const text =
      ':::finding type=compliance\nIssue 1.\n:::\nmiddle\n:::finding type=feasibility\nExisting module.\n:::';
    const result = extractFindings(text);
    expect(result).toEqual([
      { type: 'compliance', content: 'Issue 1.' },
      { type: 'feasibility', content: 'Existing module.' },
    ]);
  });

  it('extracts multiple findings (bracket syntax)', () => {
    const text =
      ':::finding[compliance]\nIssue 1.\n:::\nmiddle\n:::finding[feasibility]\nExisting module.\n:::';
    const result = extractFindings(text);
    expect(result).toEqual([
      { type: 'compliance', content: 'Issue 1.' },
      { type: 'feasibility', content: 'Existing module.' },
    ]);
  });

  it('extracts mixed syntax findings', () => {
    const text =
      ':::finding[question]\nWhat does this mean?\n:::\nmiddle\n:::finding type=risk\nData loss.\n:::';
    const result = extractFindings(text);
    expect(result).toEqual([
      { type: 'question', content: 'What does this mean?' },
      { type: 'risk', content: 'Data loss.' },
    ]);
  });

  it('extracts multiline content', () => {
    const text = ':::finding type=risk\nLine one.\nLine two.\nLine three.\n:::';
    const result = extractFindings(text);
    expect(result).toEqual([{ type: 'risk', content: 'Line one.\nLine two.\nLine three.' }]);
  });

  it('extracts multiline content (bracket syntax)', () => {
    const text = ':::finding[risk]\nLine one.\nLine two.\nLine three.\n:::';
    const result = extractFindings(text);
    expect(result).toEqual([{ type: 'risk', content: 'Line one.\nLine two.\nLine three.' }]);
  });

  it('returns empty array when no findings present', () => {
    const text = 'No findings here.';
    const result = extractFindings(text);
    expect(result).toEqual([]);
  });

  it('ignores malformed markers with no type attribute', () => {
    const text = ':::finding\nno type\n:::';
    const result = extractFindings(text);
    expect(result).toEqual([]);
  });

  it('ignores markers with invalid type', () => {
    const text = ':::finding type=invalid\ncontent\n:::';
    const result = extractFindings(text);
    expect(result).toEqual([]);
  });

  it('ignores bracket markers with invalid type', () => {
    const text = ':::finding[invalid]\ncontent\n:::';
    const result = extractFindings(text);
    expect(result).toEqual([]);
  });
});

describe('stripFindingMarkers', () => {
  it('removes finding markers and preserves surrounding text (type= syntax)', () => {
    const text = 'Before.\n:::finding type=compliance\nGDPR issue.\n:::\nAfter.';
    const result = stripFindingMarkers(text);
    expect(result).toContain('Before.');
    expect(result).toContain('After.');
    expect(result).not.toContain(':::finding');
    expect(result).not.toContain('GDPR issue.');
  });

  it('removes finding markers and preserves surrounding text (bracket syntax)', () => {
    const text = 'Before.\n:::finding[compliance]\nGDPR issue.\n:::\nAfter.';
    const result = stripFindingMarkers(text);
    expect(result).toContain('Before.');
    expect(result).toContain('After.');
    expect(result).not.toContain(':::finding');
    expect(result).not.toContain('GDPR issue.');
  });
});

describe('splitByFindings', () => {
  it('returns single text segment when no findings', () => {
    const result = splitByFindings('Just some text.');
    expect(result).toEqual([{ kind: 'text', content: 'Just some text.' }]);
  });

  it('splits text and findings into segments', () => {
    const text = 'Before text.\n:::finding[question]\nWhat does this mean?\n:::\nAfter text.';
    const result = splitByFindings(text);
    expect(result).toEqual([
      { kind: 'text', content: 'Before text.' },
      { kind: 'finding', type: 'question', content: 'What does this mean?' },
      { kind: 'text', content: 'After text.' },
    ]);
  });

  it('handles multiple findings', () => {
    const text =
      'Intro.\n:::finding[question]\nQ1?\n:::\nMiddle.\n:::finding[risk]\nRisky.\n:::\nEnd.';
    const result = splitByFindings(text);
    expect(result).toEqual([
      { kind: 'text', content: 'Intro.' },
      { kind: 'finding', type: 'question', content: 'Q1?' },
      { kind: 'text', content: 'Middle.' },
      { kind: 'finding', type: 'risk', content: 'Risky.' },
      { kind: 'text', content: 'End.' },
    ]);
  });

  it('handles finding at start of text', () => {
    const text = ':::finding[compliance]\nIssue.\n:::\nAfter.';
    const result = splitByFindings(text);
    expect(result).toEqual([
      { kind: 'finding', type: 'compliance', content: 'Issue.' },
      { kind: 'text', content: 'After.' },
    ]);
  });

  it('handles finding at end of text', () => {
    const text = 'Before.\n:::finding[dependency]\nNeeds X.\n:::';
    const result = splitByFindings(text);
    expect(result).toEqual([
      { kind: 'text', content: 'Before.' },
      { kind: 'finding', type: 'dependency', content: 'Needs X.' },
    ]);
  });

  it('returns empty array for empty string', () => {
    const result = splitByFindings('');
    expect(result).toEqual([]);
  });

  it('handles type= syntax', () => {
    const text = 'Before.\n:::finding type=risk\nDanger.\n:::\nAfter.';
    const result = splitByFindings(text);
    expect(result).toEqual([
      { kind: 'text', content: 'Before.' },
      { kind: 'finding', type: 'risk', content: 'Danger.' },
      { kind: 'text', content: 'After.' },
    ]);
  });
});

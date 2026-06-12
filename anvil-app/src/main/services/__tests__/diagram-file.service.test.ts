import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let repoPath: string;

beforeEach(() => {
  repoPath = join(tmpdir(), `diagram-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(repoPath, { recursive: true });
});

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

import {
  listDiagramFiles,
  readDiagramFile,
  writeDiagramFile,
  deleteDiagramFile,
  sanitizeFilename,
  resolveFilenameConflict,
  parseDiagramResponse,
  truncateContext,
} from '../diagram-file.service.js';

describe('listDiagramFiles', () => {
  it('should return empty array when docs/diagrams does not exist', () => {
    const result = listDiagramFiles(repoPath);
    expect(result).toEqual([]);
  });

  it('should list .drawio files with metadata', () => {
    const dir = join(repoPath, 'docs', 'diagrams');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'auth-flow.drawio'), '<mxGraphModel/>');
    writeFileSync(join(dir, 'api-arch.drawio'), '<mxGraphModel><root/></mxGraphModel>');
    writeFileSync(join(dir, 'readme.md'), 'ignore me');

    const result = listDiagramFiles(repoPath);
    expect(result).toHaveLength(2);
    expect(result.map((d) => d.filename).sort()).toEqual(['api-arch.drawio', 'auth-flow.drawio']);
    expect(result[0].title).toBeTruthy();
    expect(result[0].xml).toContain('mxGraphModel');
    expect(result[0].mtime).toBeGreaterThan(0);
  });
});

describe('readDiagramFile', () => {
  it('should read a specific diagram', () => {
    const dir = join(repoPath, 'docs', 'diagrams');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'test.drawio'), '<mxGraphModel><root/></mxGraphModel>');

    const result = readDiagramFile(repoPath, 'test.drawio');
    expect(result).not.toBeNull();
    expect(result!.filename).toBe('test.drawio');
    expect(result!.title).toBe('test');
    expect(result!.xml).toContain('mxGraphModel');
  });

  it('should return null for non-existent file', () => {
    expect(readDiagramFile(repoPath, 'nope.drawio')).toBeNull();
  });
});

describe('writeDiagramFile', () => {
  it('should create docs/diagrams directory if needed and write file', () => {
    writeDiagramFile(repoPath, 'new-diagram.drawio', '<mxGraphModel/>');
    const filePath = join(repoPath, 'docs', 'diagrams', 'new-diagram.drawio');
    expect(existsSync(filePath)).toBe(true);
  });

  it('should overwrite existing file', () => {
    const dir = join(repoPath, 'docs', 'diagrams');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'existing.drawio'), '<old/>');
    writeDiagramFile(repoPath, 'existing.drawio', '<new/>');
    const result = readDiagramFile(repoPath, 'existing.drawio');
    expect(result!.xml).toBe('<new/>');
  });
});

describe('deleteDiagramFile', () => {
  it('should remove the file', () => {
    const dir = join(repoPath, 'docs', 'diagrams');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'delete-me.drawio'), '<xml/>');
    deleteDiagramFile(repoPath, 'delete-me.drawio');
    expect(existsSync(join(dir, 'delete-me.drawio'))).toBe(false);
  });

  it('should not throw for non-existent file', () => {
    expect(() => deleteDiagramFile(repoPath, 'nope.drawio')).not.toThrow();
  });
});

describe('sanitizeFilename', () => {
  it('should replace unsafe characters', () => {
    expect(sanitizeFilename('my/diagram:v2')).toBe('my-diagram-v2');
  });

  it('should trim and lowercase', () => {
    expect(sanitizeFilename('  My Diagram  ')).toBe('my-diagram');
  });

  it('should handle empty string', () => {
    expect(sanitizeFilename('')).toBe('untitled');
  });
});

describe('resolveFilenameConflict', () => {
  it('should return original if no conflict', () => {
    expect(resolveFilenameConflict(repoPath, 'new.drawio')).toBe('new.drawio');
  });

  it('should append -1, -2 etc for conflicts', () => {
    const dir = join(repoPath, 'docs', 'diagrams');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'existing.drawio'), '<xml/>');
    expect(resolveFilenameConflict(repoPath, 'existing.drawio')).toBe('existing-1.drawio');
    writeFileSync(join(dir, 'existing-1.drawio'), '<xml/>');
    expect(resolveFilenameConflict(repoPath, 'existing.drawio')).toBe('existing-2.drawio');
  });
});

describe('parseDiagramResponse', () => {
  it('should parse valid JSON from fenced block', () => {
    const raw = '```json\n{"title":"Arch","drawioXml":"<mxGraphModel/>"}\n```';
    const result = parseDiagramResponse(raw);
    expect(result.title).toBe('Arch');
    expect(result.drawioXml).toBe('<mxGraphModel/>');
  });

  it('should throw on malformed JSON', () => {
    expect(() => parseDiagramResponse('not json')).toThrow('Failed to parse');
  });

  it('should throw when drawioXml is missing', () => {
    expect(() => parseDiagramResponse('{"title":"T"}')).toThrow('missing required drawioXml');
  });

  it('should default title when missing', () => {
    const result = parseDiagramResponse('{"drawioXml":"<xml/>"}');
    expect(result.title).toBe('Untitled Diagram');
  });
});

describe('truncateContext', () => {
  it('should return short context unchanged', () => {
    expect(truncateContext('short')).toBe('short');
  });

  it('should truncate keeping most recent words', () => {
    const words = Array.from({ length: 100 }, (_, i) => `w${i}`);
    const result = truncateContext(words.join(' '), 10);
    expect(result.split(' ')).toHaveLength(10);
    expect(result).toContain('w99');
  });
});

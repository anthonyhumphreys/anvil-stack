import { describe, expect, it } from 'vitest';
import type { CodexEvent } from '../../../../shared/types';
import {
  getActivityAnnouncement,
  getVisibleActivityPills,
  summarizeActivity,
} from '../ChatStatusBar';

describe('summarizeActivity', () => {
  it('counts concrete activity and keeps the latest human-readable label', () => {
    const summary = summarizeActivity([
      { type: 'file_read', filePath: 'src/a.ts' },
      { type: 'file_edit', filePath: 'src/a.ts' },
      { type: 'command_exec', command: 'npm test' },
      { type: 'tool_call', toolName: 'apply_patch' },
    ] satisfies CodexEvent[]);

    expect(summary.files).toBe(1);
    expect(summary.edits).toBe(1);
    expect(summary.commands).toBe(1);
    expect(summary.tools).toBe(1);
    expect(summary.latest?.label).toBe('Using apply_patch');
  });
});

describe('getVisibleActivityPills', () => {
  it('hides empty categories from the compact status bar', () => {
    const pills = getVisibleActivityPills({
      latest: null,
      recent: [],
      files: 2,
      edits: 0,
      commands: 1,
      tools: 0,
    });

    expect(pills.map((pill) => pill.label)).toEqual(['Files', 'Commands']);
  });
});

describe('getActivityAnnouncement', () => {
  it('announces the latest activity or a generic processing state', () => {
    expect(getActivityAnnouncement({ label: 'Running npm test', icon: null })).toBe(
      'Running npm test',
    );
    expect(getActivityAnnouncement(null)).toBe('Processing');
  });
});

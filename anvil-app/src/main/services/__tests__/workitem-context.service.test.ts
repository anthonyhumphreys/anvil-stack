import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../db/schema.js';
import type { AppSettings, WorkItem } from '../../../shared/types.js';
const db = new Database(':memory:');
db.exec(SCHEMA_SQL);
vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('../settings.service.js', () => ({ getSettings: () => ({ workItemProvider: 'linear' }) }));
import {
  withWorkItemContext,
  cacheWorkItems,
  cacheSingleWorkItem,
  getCachedWorkItem,
  getCachedWorkItems,
  getWorkItemSettings,
} from '../workitem-context.service.js';
import {
  extractAcceptanceCriteria,
  workItemText,
  buildWorkItemIntent,
} from '../../../shared/workitem-intent.js';
const settings = (id: string) =>
  ({ workItemProvider: 'linear', activeWorkItemConnectionId: id, linearTeamId: id }) as AppSettings;
const item = (title: string) =>
  ({ id: 'WI-1', title, provider: 'linear', priority: 1, type: 'Task', state: 'Open' }) as WorkItem;
beforeEach(() => db.exec('DELETE FROM scoped_work_items_cache'));
describe('Work Item connection and intent', () => {
  it('isolates identical IDs across connections and bypasses cache on explicit refresh', () => {
    withWorkItemContext(settings('a'), false, () => cacheWorkItems([item('A')]));
    withWorkItemContext(settings('b'), false, () => cacheWorkItems([item('B')]));
    expect(withWorkItemContext(settings('a'), false, () => getCachedWorkItems()?.[0].title)).toBe(
      'A',
    );
    expect(withWorkItemContext(settings('b'), false, () => getCachedWorkItems()?.[0].title)).toBe(
      'B',
    );
    expect(withWorkItemContext(settings('a'), true, () => getCachedWorkItems())).toBeNull();
  });
  it('does not treat individual fetches as a complete list', () => {
    withWorkItemContext(settings('single-only'), false, () => {
      cacheSingleWorkItem(item('One'));
      expect(getCachedWorkItem('WI-1')?.title).toBe('One');
      expect(getCachedWorkItems()).toBeNull();
      cacheWorkItems([]);
      cacheSingleWorkItem(item('Outside list'));
      expect(getCachedWorkItems()).toEqual([]);
    });
  });
  it('keeps credentials and scope fixed across asynchronous concurrent provider calls', async () => {
    const results = await Promise.all(
      ['a', 'b'].map((id) =>
        withWorkItemContext(settings(id), true, async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return getWorkItemSettings().linearTeamId;
        }),
      ),
    );
    expect(results).toEqual(['a', 'b']);
  });
  it('preserves explicit rich text criteria without treating other task prose as approved', () => {
    expect(
      extractAcceptanceCriteria({
        acceptanceCriteria: workItemText('<p>Save settings</p><p>Keep values</p>', 'html'),
      }),
    ).toBe('Save settings\nKeep values');
    expect(
      extractAcceptanceCriteria({
        description: '## Acceptance criteria\n- Save settings\n## Notes\nMore context',
      }),
    ).toBe('- Save settings');
    expect(extractAcceptanceCriteria({ description: 'It should probably save settings.' })).toBe(
      '',
    );
    expect(
      workItemText({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'One' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Two' }] },
        ],
      }),
    ).toBe('One\nTwo');
  });
  it('preserves Markdown and literal angle brackets across repeated extraction', () => {
    const text =
      '- Render <button> with Save\n- Reject values < 10 and > 100\n- Keep &amp; literal';
    expect(
      extractAcceptanceCriteria({
        description: `## Acceptance criteria\n${text}\n## Notes\nLater`,
      }),
    ).toBe(text);
    expect(extractAcceptanceCriteria({ acceptanceCriteria: text })).toBe(text);
    expect(workItemText(text)).toBe(text);
    expect(workItemText('<p>Keep &amp;lt;button&amp;gt; literal</p>', 'html')).toBe(
      'Keep &lt;button&gt; literal',
    );
  });
  it('stops at the next rich-text heading for ADF and HTML', () => {
    const adf = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Acceptance criteria' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Render <button> and reject values < 10' }],
        },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Notes' }] },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Maybe remove permission checks later' }],
        },
      ],
    };
    expect(extractAcceptanceCriteria({ description: workItemText(adf) })).toBe(
      'Render <button> and reject values < 10',
    );
    expect(
      extractAcceptanceCriteria({
        description: workItemText(
          '<h2>Acceptance criteria</h2><p>Render &lt;button&gt;</p><h2>Notes</h2><p>Later</p>',
          'html',
        ),
      }),
    ).toBe('Render <button>');
  });
  it('distinguishes a planning-only request from implementation with conditional clarification', () => {
    expect(buildWorkItemIntent(item('Settings'), 'plan')).toContain(
      'do not modify code until I approve',
    );
    expect(buildWorkItemIntent(item('Settings'), 'implement')).toContain(
      'Otherwise implement and verify',
    );
    expect(buildWorkItemIntent(item('Settings'), 'implement')).toContain(
      'No explicit criteria provided',
    );
  });
});

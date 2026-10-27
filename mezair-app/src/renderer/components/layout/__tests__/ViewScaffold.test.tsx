import { renderToStaticMarkup } from 'react-dom/server';
import { AlertTriangle, Inbox } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { EmptyState, InlineNotice, ViewHeader } from '../ViewScaffold';

describe('ViewScaffold', () => {
  it('gives every top-level view one semantic heading and optional actions', () => {
    const markup = renderToStaticMarkup(
      <ViewHeader
        icon={Inbox}
        title="Inbox"
        description="Work that needs attention."
        actions={<button type="button">Refresh</button>}
      />,
    );

    expect(markup).toContain('<header');
    expect(markup).toContain('<h1');
    expect(markup).toContain('Work that needs attention.');
    expect(markup).toContain('Refresh');
  });

  it('renders actionable empty-state guidance without decorative heading inflation', () => {
    const markup = renderToStaticMarkup(
      <EmptyState
        icon={Inbox}
        title="Nothing needs attention"
        description="New approvals will appear here."
      />,
    );

    expect(markup).toContain('<h2');
    expect(markup).toContain('New approvals will appear here.');
  });

  it('announces error notices while neutral status remains non-interruptive', () => {
    const errorMarkup = renderToStaticMarkup(
      <InlineNotice icon={AlertTriangle} tone="error">
        Connection failed.
      </InlineNotice>,
    );
    const statusMarkup = renderToStaticMarkup(<InlineNotice>Ready.</InlineNotice>);

    expect(errorMarkup).toContain('role="alert"');
    expect(statusMarkup).toContain('role="status"');
  });
});

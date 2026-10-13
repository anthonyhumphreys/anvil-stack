import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Send, ListChecks } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { ComposerSendControl, type ComposerSendOption } from '../ComposerSendControl';

const option = (id: string, overrides: Partial<ComposerSendOption> = {}): ComposerSendOption => ({
  id,
  label: `${id} label`,
  shortLabel: id,
  description: `${id} description`,
  icon: id === 'queue' ? ListChecks : Send,
  disabled: false,
  pending: false,
  ariaLabel: `${id} aria`,
  run: () => undefined,
  ...overrides,
});

describe('ComposerSendControl', () => {
  it('shows one primary action and offers alternatives behind a menu', () => {
    const html = renderToStaticMarkup(
      createElement(ComposerSendControl, {
        options: [option('guide'), option('queue')],
        selectedId: 'queue',
        onSelect: () => undefined,
        colour: 'var(--color-accent)',
        hasContent: true,
        menuLabel: 'More ways to send',
      }),
    );
    expect(html).toContain('aria-label="queue aria"');
    expect(html).not.toContain('aria-label="guide aria"');
    expect(html).toContain('aria-label="More ways to send"');
  });

  it('omits the menu when there is only one way to send and falls back to the first option', () => {
    const html = renderToStaticMarkup(
      createElement(ComposerSendControl, {
        options: [option('send', { disabled: true })],
        selectedId: 'side',
        onSelect: () => undefined,
        colour: 'var(--color-accent)',
        hasContent: false,
        menuLabel: 'More ways to send',
      }),
    );
    expect(html).toContain('aria-label="send aria"');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('More ways to send');
  });
});

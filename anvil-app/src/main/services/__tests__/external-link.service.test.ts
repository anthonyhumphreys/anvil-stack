import { beforeEach, describe, expect, it, vi } from 'vitest';

const { buildFromTemplateMock, copyLinkMock, openExternalMock } = vi.hoisted(() => ({
  buildFromTemplateMock: vi.fn(() => ({ popup: vi.fn() })),
  copyLinkMock: vi.fn(),
  openExternalMock: vi.fn(() => Promise.resolve()),
}));

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
  clipboard: { writeText: copyLinkMock },
  Menu: { buildFromTemplate: buildFromTemplateMock },
  shell: { openExternal: openExternalMock },
}));

import {
  buildExternalLinkMenu,
  isExternalLink,
  registerExternalLinkHandling,
} from '../external-link.service.js';

describe('external link handling', () => {
  beforeEach(() => {
    buildFromTemplateMock.mockClear();
    copyLinkMock.mockClear();
    openExternalMock.mockClear();
  });

  it('accepts browser URLs and rejects unsafe or malformed links', () => {
    expect(isExternalLink('https://example.com/path')).toBe(true);
    expect(isExternalLink('http://localhost:5173')).toBe(true);
    expect(isExternalLink('javascript:alert(1)')).toBe(false);
    expect(isExternalLink('file:///tmp/private')).toBe(false);
    expect(isExternalLink('not a URL')).toBe(false);
  });

  it('builds actions that open and copy a link', () => {
    const menu = buildExternalLinkMenu('https://example.com/path');

    expect(menu.map((item) => item.label)).toEqual(['Open Link in Browser', 'Copy Link']);
    menu[0]?.click?.({} as never, {} as never, {} as never);
    menu[1]?.click?.({} as never, {} as never, {} as never);

    expect(openExternalMock).toHaveBeenCalledWith('https://example.com/path');
    expect(copyLinkMock).toHaveBeenCalledWith('https://example.com/path');
  });

  it('opens new-window links externally and denies the in-app popup', () => {
    let windowOpenHandler: ((details: { url: string }) => { action: 'deny' }) | undefined;
    const contents = {
      setWindowOpenHandler: vi.fn((handler) => {
        windowOpenHandler = handler;
      }),
      on: vi.fn(),
    };

    registerExternalLinkHandling(contents as never);
    const result = windowOpenHandler?.({ url: 'https://example.com' });

    expect(result).toEqual({ action: 'deny' });
    expect(openExternalMock).toHaveBeenCalledWith('https://example.com');
  });
});

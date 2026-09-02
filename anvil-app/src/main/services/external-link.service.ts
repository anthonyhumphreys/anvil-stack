import {
  BrowserWindow,
  clipboard,
  Menu,
  shell,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron';

const EXTERNAL_LINK_PROTOCOLS = new Set(['http:', 'https:']);

export function isExternalLink(url: string): boolean {
  try {
    return EXTERNAL_LINK_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

function openExternalLink(url: string): void {
  if (!isExternalLink(url)) return;
  void shell.openExternal(url).catch((error) => {
    console.error(`Failed to open external link: ${url}`, error);
  });
}

export function buildExternalLinkMenu(url: string): MenuItemConstructorOptions[] {
  if (!isExternalLink(url)) return [];

  return [
    {
      label: 'Open Link in Browser',
      click: () => openExternalLink(url),
    },
    {
      label: 'Copy Link',
      click: () => clipboard.writeText(url),
    },
  ];
}

export function registerExternalLinkHandling(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    openExternalLink(url);
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (!isExternalLink(url)) return;
    event.preventDefault();
    openExternalLink(url);
  });

  contents.on('context-menu', (_event, params) => {
    const template = buildExternalLinkMenu(params.linkURL);
    if (template.length === 0) return;

    const window = BrowserWindow.fromWebContents(contents) ?? undefined;
    Menu.buildFromTemplate(template).popup({ window });
  });
}

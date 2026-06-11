import type { DocPage } from '../../shared/types.js';
import { getSettings } from './settings.service.js';
import { confluenceProvider } from './confluence.service.js';
import { notionProvider } from './notion.service.js';

export interface DocsProviderService {
  listPages(spaceKeyOrParent?: string): Promise<DocPage[]>;
  listChildren(pageId: string): Promise<DocPage[]>;
  getPageContent(pageId: string): Promise<string>;
  checkStaleness(pageId: string, repoLastCommitDate: string): Promise<DocPage['staleness']>;
  createPage(spaceKeyOrParent: string, title: string, content: string): Promise<string>;
  updatePage(pageId: string, title: string, content: string): Promise<void>;
  testConnection(): Promise<{ ok: boolean; error?: string }>;
  isConfigured(): boolean;
  getSpaceKeyOrParent(): string;
}

export function getActiveDocsProvider(): DocsProviderService | null {
  const settings = getSettings();
  switch (settings.docsProvider) {
    case 'confluence':
      return confluenceProvider;
    case 'notion':
      return notionProvider;
    case 'none':
      return null;
    default:
      return null;
  }
}

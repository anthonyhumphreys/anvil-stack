import { createContext } from 'react';
import { parseSurfaceFenceHeader } from '../../../shared/surfaces/fences';
import type { ChatArtifact } from '../../../shared/types';

/** True while the enclosing assistant message is still streaming. */
export const MessageStreamingContext = createContext(false);

export interface FenceInfo {
  relativePath?: string;
  title?: string;
  kind?: string;
  /** Sketch height hint in px. */
  height?: number;
}

/** `artifact`, `artifact:path`, or `sketch` fence languages render as surfaces, not code. */
export function surfaceFenceKind(language: string): 'artifact' | 'sketch' | null {
  if (language === 'artifact' || language.startsWith('artifact:')) return 'artifact';
  if (language === 'sketch') return 'sketch';
  return null;
}

export function readFenceLanguage(className: string | undefined): string {
  return className?.match(/(?:^|\s)language-(\S+)/)?.[1] ?? '';
}

/** Parses `artifact:path key=value title="…"` headers (language + meta) with the shared grammar. */
export function parseFenceInfo(language: string, meta: string | undefined): FenceInfo {
  const header = parseSurfaceFenceHeader(`${language} ${meta ?? ''}`);
  if (!header) return {};
  const info: FenceInfo = {};
  if (header.path) info.relativePath = header.path;
  if (header.title) info.title = header.title;
  if (header.kind) info.kind = header.kind;
  if (header.height) info.height = header.height;
  return info;
}

/** The persisted artifact for a fence: matched by relative path, else by title. */
export function findFenceArtifact(
  artifacts: readonly ChatArtifact[],
  info: FenceInfo,
): ChatArtifact | undefined {
  if (info.relativePath) {
    const byPath = artifacts.find((artifact) => artifact.relativePath === info.relativePath);
    if (byPath) return byPath;
  }
  return info.title ? artifacts.find((artifact) => artifact.title === info.title) : undefined;
}

export function fenceTitleFromPath(relativePath: string | undefined): string | undefined {
  if (!relativePath) return undefined;
  const fileName = relativePath.split('/').filter(Boolean).pop() ?? relativePath;
  return fileName.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
}

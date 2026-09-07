import type { GateCriterion } from './lifecycle-types';

export const DEFAULT_COMPLIANCE_PATHS = [
  'docs/DPIA.md',
  'docs/PRIVACY_POLICY.md',
  'docs/TERMS_OF_SERVICE.md',
];
export interface DocumentGateConfig {
  source: 'repository' | 'manual';
  paths: string[];
  match: 'any' | 'all';
  repositories: 'all' | 'any';
  reference: string;
}
export function documentGateConfig(criterion: GateCriterion): DocumentGateConfig {
  const config = criterion.config ?? {};
  const paths =
    config.paths ?? (criterion.type === 'compliance_doc' ? DEFAULT_COMPLIANCE_PATHS : []);
  if (
    !Array.isArray(paths) ||
    paths.length > 50 ||
    paths.some(
      (path) =>
        typeof path !== 'string' ||
        !path.trim() ||
        path.length > 1000 ||
        path.startsWith('/') ||
        path.includes('\\') ||
        path.includes(':') ||
        path.split('/').some((part) => part === '..' || part === '.') ||
        /[*?\[\]]/.test(path) ||
        path.includes('\0'),
    )
  )
    throw new Error(
      'Use up to 50 exact repository-relative file paths, without wildcards or parent traversal.',
    );
  if (config.source !== undefined && !['repository', 'manual'].includes(String(config.source)))
    throw new Error('Invalid document source.');
  if (config.match !== undefined && !['any', 'all'].includes(String(config.match)))
    throw new Error('Invalid file matching rule.');
  if (config.repositories !== undefined && !['any', 'all'].includes(String(config.repositories)))
    throw new Error('Invalid repository matching rule.');
  if (
    config.reference !== undefined &&
    (typeof config.reference !== 'string' || config.reference.length > 4000)
  )
    throw new Error('Document reference must be text of up to 4000 characters.');
  const source = (config.source ?? 'repository') as DocumentGateConfig['source'];
  if (source === 'repository' && criterion.type === 'compliance_doc' && !paths.length)
    throw new Error('Add at least one document path or choose manual review.');
  return {
    source,
    paths: paths.map((path) => path.trim()),
    match: (config.match ?? 'any') as DocumentGateConfig['match'],
    repositories: (config.repositories ?? 'all') as DocumentGateConfig['repositories'],
    reference: (config.reference as string | undefined) ?? '',
  };
}

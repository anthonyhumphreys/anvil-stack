import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseSkillRecommendationSources,
  SKILL_RECOMMENDATIONS_FEATURE,
} from '../../../../cloud/contract/skill-recommendations.js';
import { buildSkillCliArgs } from '../codex-registry.service.js';
import type { OrganizationSkillRecommendations } from '../../../shared/skill-recommendations.js';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), install: vi.fn(), fetch: vi.fn() }));
vi.mock('../sync-backend-client.service.js', () => ({ rpc: mocks.rpc }));
vi.mock('../codex-registry.service.js', async (original) => ({
  ...(await original<typeof import('../codex-registry.service.js')>()),
  installCodexSkill: mocks.install,
}));
import {
  configureSkillRecommendationsContext,
  getSkillRecommendationCatalog,
  inspectRecommendedSkillCollection,
  installRecommendedSkillCollection,
  saveOrganizationSkillRecommendations,
} from '../skill-recommendations.service.js';

const source = {
  id: 'team',
  name: 'Team skills',
  description: 'Team workflows',
  repository: 'acme/skills',
  path: 'skills',
};
const org = { organizationId: 'org1', name: 'Acme', canEdit: true, version: 3, sources: [source] };
const commit = 'a'.repeat(40);
const blob = 'b'.repeat(40);
let scopeKey: string | null;
let orgs: OrganizationSkillRecommendations[] = [org];
let treeOverride: unknown;

beforeEach(() => {
  vi.clearAllMocks();
  scopeKey = `test-${crypto.randomUUID()}`;
  orgs = [org];
  treeOverride = undefined;
  configureSkillRecommendationsContext(() =>
    scopeKey
      ? {
          scopeKey,
          apiUrl: 'https://anvil.test/v1',
          accessToken: 'session',
          features: [SKILL_RECOMMENDATIONS_FEATURE],
        }
      : null,
  );
  mocks.rpc.mockImplementation(async () => ({ result: { organizations: orgs } }));
  mocks.install.mockResolvedValue({ success: true, command: 'npx skills add' });
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url.includes('/commits/')) return Response.json({ sha: commit });
    if (url.includes('/git/trees/'))
      return Response.json(
        treeOverride ?? {
          tree: [
            { path: 'skills/review/SKILL.md', sha: blob, type: 'blob', mode: '100644' },
            { path: 'other/SKILL.md', sha: 'c'.repeat(40), type: 'blob', mode: '100644' },
            { path: 'skills/link/SKILL.md', sha: 'd'.repeat(40), type: 'blob', mode: '120000' },
          ],
        },
      );
    return Response.json({
      content: Buffer.from(
        '---\nname: review\ndescription: >-\n  Review a change\n  with evidence.\n---\nNever run this content during discovery.',
      ).toString('base64'),
      encoding: 'base64',
      size: 150,
    });
  });
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  configureSkillRecommendationsContext(() => null);
});
const selection = () => ({ scopeKey, organizationId: 'org1', sourceId: 'team' });

describe('curated source configuration', () => {
  it('normalizes GitHub links and preserves collection order and selections', () => {
    expect(
      parseSkillRecommendationSources([
        { ...source, repository: 'https://github.com/acme/skills.git', skills: ['review'] },
      ]),
    ).toEqual([{ ...source, skills: ['review'] }]);
  });
  it.each([
    'https://evil.test/acme/skills',
    '-flag/repo',
    'owner/repo/tree/main',
    '../repo',
    'git@github.com:acme/skills',
  ])('rejects an untrusted source format: %s', (repository) => {
    expect(() => parseSkillRecommendationSources([{ ...source, repository }])).toThrow();
  });
  it.each(['../secrets', '/skills', 'skills/../other', 'skills//other'])(
    'rejects a path outside the chosen directory: %s',
    (path) => {
      expect(() => parseSkillRecommendationSources([{ ...source, path }])).toThrow();
    },
  );
  it('rejects duplicate ids and empty skill allowlists', () => {
    expect(() => parseSkillRecommendationSources([source, source])).toThrow();
    expect(() => parseSkillRecommendationSources([{ ...source, skills: [] }])).toThrow();
  });
  it('builds one bounded, shell-free command for the whole collection', () => {
    expect(
      buildSkillCliArgs({
        source: `https://github.com/acme/skills/tree/${commit}/skills`,
        skillNames: ['review', 'test'],
        global: true,
      }),
    ).toEqual([
      'skills',
      'add',
      `https://github.com/acme/skills/tree/${commit}/skills`,
      '--skill',
      'review',
      'test',
      '-a',
      'codex',
      '-g',
      '-y',
    ]);
    expect(() => buildSkillCliArgs({ source: 'acme/skills', skillNames: ['--all'] })).toThrow();
  });
});

describe('recommended collections', () => {
  it('lists the editorial sources without network access or installs when signed out', async () => {
    scopeKey = null;
    const catalog = await getSkillRecommendationCatalog();
    expect(catalog.sources.map((item) => item.id)).toEqual(['theo', 'poteto', 'matt-pocock']);
    expect(catalog.organizations).toEqual([]);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it('discovers only skills from the selected source directory and parses folded YAML', async () => {
    const inspection = await inspectRecommendedSkillCollection(selection());
    expect(inspection).toEqual({
      commit,
      skills: [
        {
          name: 'review',
          description: 'Review a change with evidence.',
          url: `https://github.com/acme/skills/blob/${commit}/skills/review/SKILL.md`,
        },
      ],
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it('installs the full collection at the resolved commit', async () => {
    await installRecommendedSkillCollection(selection());
    expect(mocks.install).toHaveBeenCalledWith({
      source: `https://github.com/acme/skills/tree/${commit}/skills`,
      skillNames: ['review'],
      global: true,
    });
  });
  it('rejects missing selections rather than installing the remainder', async () => {
    orgs = [{ ...org, sources: [{ ...source, skills: ['missing'] }] }];
    await expect(installRecommendedSkillCollection(selection())).rejects.toThrow('not found');
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it('rechecks membership even after a cached inspection', async () => {
    await inspectRecommendedSkillCollection(selection());
    orgs = [];
    await expect(installRecommendedSkillCollection(selection())).rejects.toThrow(
      'no longer available',
    );
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it('rejects a catalogue change during repository inspection', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ result: { organizations: [org] } })
      .mockResolvedValue({
        result: {
          organizations: [{ ...org, sources: [{ ...source, repository: 'acme/replacement' }] }],
        },
      });
    await expect(installRecommendedSkillCollection(selection())).rejects.toThrow(
      'collection changed',
    );
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it('rejects an account switch while a request is in flight', async () => {
    const input = selection();
    mocks.rpc.mockImplementation(async () => {
      scopeKey = 'other';
      return { result: { organizations: [org] } };
    });
    await expect(installRecommendedSkillCollection(input)).rejects.toThrow('account changed');
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it('fails closed on incomplete trees and unknown individual skill names', async () => {
    treeOverride = { truncated: true, tree: [] };
    await expect(inspectRecommendedSkillCollection(selection())).rejects.toThrow(
      'inspect completely',
    );
    treeOverride = undefined;
    await expect(
      installRecommendedSkillCollection({ ...selection(), skillName: 'other' }),
    ).rejects.toThrow('not part');
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it('keeps built-in sources available when the org backend fails', async () => {
    mocks.rpc.mockRejectedValue(new Error('Offline. Retry later.'));
    const catalog = await getSkillRecommendationCatalog();
    expect(catalog.sources).toHaveLength(3);
    expect(catalog.organizations).toEqual([]);
    expect(catalog.warning).toBe('Offline. Retry later.');
  });
  it('sends validated org configuration with an optimistic version', async () => {
    await saveOrganizationSkillRecommendations({
      scopeKey: scopeKey!,
      organizationId: 'org1',
      expectedVersion: 3,
      sources: [source],
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      { apiUrl: 'https://anvil.test/v1' },
      'skills.recommendations.set',
      { organizationId: 'org1', expectedVersion: 3, sources: [source] },
      'session',
    );
  });
});

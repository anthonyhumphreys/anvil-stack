import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleSkillRecommendationsOperation } from '../src/hosted/skill-recommendations';
import type { VerifiedAuth } from '../src/auth';
import { spikeBearer } from './helpers';
import { PROTOCOL } from '../../contract/version';
import {
  HOSTED_OPERATION_CLASS,
  OPERATION_PROFILE,
  OPERATION_ROLE,
  OPERATIONS,
} from '../../contract/operations';

const db = env.HOSTED_DB!;
const auth: VerifiedAuth = { accountId: 'sync_skills_owner', enrollmentId: 'device_skills_owner' };
const source = {
  id: 'theo',
  name: "Theo's skills",
  description: 'Everyday engineering',
  repository: 't3dotgg/tstack',
  path: 'skills',
};
const update = (expectedVersion = 0, sources: unknown = [source]) => ({
  organizationId: 'org_skills',
  expectedVersion,
  sources,
});

async function call(operation: string, params: unknown = {}, actor = auth) {
  const result = await handleSkillRecommendationsOperation(operation, params, actor, env as Env);
  return { status: result.status, body: (await result.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  await db.prepare('DELETE FROM hosted_skill_recommendations').run();
  await db
    .prepare("DELETE FROM hosted_organization_memberships WHERE organization_id = 'org_skills'")
    .run();
  await db.prepare("DELETE FROM hosted_organizations WHERE id = 'org_skills'").run();
  await db.prepare("DELETE FROM billing_accounts WHERE id = 'billing_skills'").run();
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO billing_accounts
    (id, workos_client_id, workos_user_id, sync_account_id, generation, lifecycle, created_at, updated_at)
    VALUES ('billing_skills','client_skills','user_skills','sync_skills_owner',1,'active',?,?)`,
    )
    .bind(now, now)
    .run();
  await db
    .prepare(
      `INSERT INTO hosted_organizations
    (id,idempotency_key,workos_organization_id,name,status,created_by_workos_user_id,created_at,updated_at)
    VALUES ('org_skills','idem_skills','workos_org_skills','Skills team','active','user_skills',?,?)`,
    )
    .bind(now, now)
    .run();
  await db
    .prepare(
      `INSERT INTO hosted_organization_memberships
    (organization_id,billing_account_id,workos_client_id,workos_user_id,email,workos_membership_id,workos_sync_status,role,status,seat_opted_out,created_at,updated_at)
    VALUES ('org_skills','billing_skills','client_skills','user_skills','owner@example.test','member_skills','synced','owner','active',0,?,?)`,
    )
    .bind(now, now)
    .run();
});

describe('organisation skill recommendations', () => {
  it('advertises reads and owner configuration as user control operations', () => {
    for (const operation of [
      'skills.recommendations.list',
      'skills.recommendations.set',
    ] as const) {
      expect(OPERATIONS).toContain(operation);
      expect(OPERATION_PROFILE[operation]).toBe('sync/2');
      expect(OPERATION_ROLE[operation]).toBe('user');
      expect(HOSTED_OPERATION_CLASS[operation]).toBe('control');
    }
  });
  it('allows owners to publish, replace and clear their shared catalogue', async () => {
    expect((await call('skills.recommendations.set', update())).status).toBe(200);
    expect((await call('skills.recommendations.list')).body).toEqual({
      organizations: [
        {
          organizationId: 'org_skills',
          name: 'Skills team',
          version: 1,
          canEdit: true,
          sources: [source],
        },
      ],
    });
    expect((await call('skills.recommendations.set', update(1, []))).body).toEqual({ version: 2 });
    expect((await call('skills.recommendations.list')).body).toMatchObject({
      organizations: [{ version: 2, sources: [] }],
    });
  });
  it('allows members to read but never configure recommendations', async () => {
    await call('skills.recommendations.set', update());
    await db
      .prepare(
        "UPDATE hosted_organization_memberships SET role='member' WHERE organization_id='org_skills'",
      )
      .run();
    expect((await call('skills.recommendations.list')).body).toMatchObject({
      organizations: [{ canEdit: false, sources: [source] }],
    });
    expect((await call('skills.recommendations.set', update(1, []))).status).toBe(403);
  });
  it('excludes outsiders even when they provide the org id', async () => {
    const outsider = { ...auth, accountId: 'another_account' };
    expect(
      (await call('skills.recommendations.list', { organizationId: 'org_skills' }, outsider)).body,
    ).toEqual({ organizations: [] });
    expect((await call('skills.recommendations.set', update(), outsider)).status).toBe(403);
  });
  it.each([
    "UPDATE hosted_organization_memberships SET status='inactive' WHERE organization_id='org_skills'",
    "UPDATE hosted_organization_memberships SET workos_sync_status='pending' WHERE organization_id='org_skills'",
    "UPDATE hosted_organizations SET status='closed' WHERE id='org_skills'",
    "UPDATE billing_accounts SET lifecycle='deleted' WHERE id='billing_skills'",
    "UPDATE hosted_organization_memberships SET workos_user_id='mismatched' WHERE organization_id='org_skills'",
  ])('rechecks current membership and account state: %s', async (sql) => {
    await call('skills.recommendations.set', update());
    await db.prepare(sql).run();
    expect((await call('skills.recommendations.list')).body).toEqual({ organizations: [] });
    expect((await call('skills.recommendations.set', update(1, []))).status).toBe(403);
  });
  it('prevents lost updates, including competing initial writes', async () => {
    const results = await Promise.all([
      call('skills.recommendations.set', update()),
      call('skills.recommendations.set', update()),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect((await call('skills.recommendations.set', update(0, []))).status).toBe(409);
    expect((await call('skills.recommendations.list')).body).toMatchObject({
      organizations: [{ version: 1, sources: [source] }],
    });
  });
  it('rejects malformed repositories, traversal, and optimistic versions', async () => {
    for (const params of [
      update(-1),
      update(0.5),
      update(0, [{ ...source, repository: 'https://evil.test/repo' }]),
      update(0, [{ ...source, path: '../other' }]),
    ]) {
      expect((await call('skills.recommendations.set', params)).status).toBe(400);
    }
  });
  it('does not allow ephemeral workers to access organisation catalogues', async () => {
    for (const operation of ['skills.recommendations.list', 'skills.recommendations.set']) {
      expect(
        (await call(operation, update(), { ...auth, enrollmentClass: 'ephemeral' })).status,
      ).toBe(403);
    }
  });
  it('routes through the authenticated RPC envelope with private cache headers', async () => {
    const result = await SELF.fetch('https://spike.test/v1/rpc', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: spikeBearer(auth.accountId, auth.enrollmentId),
      },
      body: JSON.stringify({
        protocol: PROTOCOL,
        requestId: 'skills-request',
        operation: 'skills.recommendations.list',
        params: {},
      }),
    });
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('private, no-store');
    expect(await result.json()).toMatchObject({
      result: { organizations: [{ organizationId: 'org_skills' }] },
    });
  });
});

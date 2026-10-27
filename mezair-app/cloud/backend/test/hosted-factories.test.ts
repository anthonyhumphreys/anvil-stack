import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerifiedAuth } from '../src/auth';
import { handleFactoryOperation } from '../src/hosted/factories';
import {
  HOSTED_OPERATION_CLASS,
  OPERATION_PROFILE,
  OPERATION_ROLE,
  OPERATIONS,
} from '../../contract/operations';
import { isRpcError } from '../../contract/envelope';
import { postRpc, spikeBearer } from './helpers';

const db = env.HOSTED_DB!;
const auth: VerifiedAuth = {
  accountId: 'sync_factory_actor',
  enrollmentId: 'device_factory_actor',
};
const organizationId = 'org_factory_test',
  userId = 'workos_factory_owner';
const policy = { organizationId, visibility: 'organization', members: [] } as const;
const source = { host: 'github.com', owner: 'acme', repo: 'mezair' } as const;
let privateRepo = false,
  denyCollaborator = false;
const githubDefault = async (url: string | URL) => {
  const path = String(url);
  if (path.endsWith('/user')) return Response.json({ login: 'factory-owner' });
  if (path.includes('/teams/')) return Response.json({ state: 'active' });
  if (path.includes('/collaborators/'))
    return Response.json({ permission: denyCollaborator ? 'none' : 'read' });
  if (path.includes('/repos/'))
    return Response.json({
      full_name: 'acme/mezair',
      private: privateRepo,
      permissions: { pull: true },
    });
  return Response.json({});
};
const github = vi.fn(githubDefault);
beforeEach(async () => {
  privateRepo = false;
  denyCollaborator = false;
  vi.stubGlobal('fetch', github);
  github.mockReset();
  github.mockImplementation(githubDefault);
  await db.prepare('DELETE FROM hosted_factory_issue_claims').run();
  await db.prepare('DELETE FROM hosted_factory_commands').run();
  await db.prepare('DELETE FROM hosted_factory_runs').run();
  await db.prepare('DELETE FROM hosted_factory_audit').run();
  await db.prepare('DELETE FROM hosted_factories').run();
  await db.prepare('DELETE FROM hosted_factory_keys').run();
  await db
    .prepare('DELETE FROM hosted_organization_memberships WHERE organization_id=?')
    .bind(organizationId)
    .run();
  await db.prepare('DELETE FROM hosted_organizations WHERE id=?').bind(organizationId).run();
  await db.prepare('DELETE FROM billing_accounts WHERE id=?').bind('billing_factory_owner').run();
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO billing_accounts(id,workos_client_id,workos_user_id,sync_account_id,generation,lifecycle,created_at,updated_at)
    VALUES('billing_factory_owner','client_factory_test',?, ?,1,'active',?,?)`,
    )
    .bind(userId, auth.accountId, now, now)
    .run();
  await db
    .prepare(
      `INSERT INTO hosted_organizations(id,idempotency_key,workos_organization_id,name,status,created_by_workos_user_id,created_at,updated_at)
    VALUES(?,'idem_factory_test','provider_factory_test','Factory test','active',?,?,?)`,
    )
    .bind(organizationId, userId, now, now)
    .run();
  await db
    .prepare(
      `INSERT INTO hosted_organization_memberships(organization_id,billing_account_id,workos_client_id,workos_user_id,email,workos_membership_id,workos_sync_status,role,status,seat_opted_out,created_at,updated_at)
    VALUES(?,'billing_factory_owner','client_factory_test',?,'owner@example.test','member_factory_test','synced','owner','active',0,?,?)`,
    )
    .bind(organizationId, userId, now, now)
    .run();
});

async function call(operation: string, input: unknown, actingAuth: VerifiedAuth = auth) {
  const response = await handleFactoryOperation(operation, input, actingAuth, env as Env);
  return {
    ok: response.ok,
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}
const wrap = (pub: string) => ({
  ephemeral: pub,
  publicKey: pub,
  nonce: Buffer.alloc(12, 3).toString('base64'),
  tag: Buffer.alloc(16, 4).toString('base64'),
  ciphertext: Buffer.alloc(48, 5).toString('base64'),
});
const sealed = (keys: Record<string, string>) => ({
  nonce: Buffer.alloc(12, 1).toString('base64'),
  tag: Buffer.alloc(16, 2).toString('base64'),
  ciphertext: Buffer.from('sealed').toString('base64'),
  keys: Object.fromEntries(Object.entries(keys).map(([user, pub]) => [user, wrap(pub)])),
});
const upsert = (factoryId: string, options: Record<string, unknown> = {}) =>
  call('factory.registry.upsert', {
    factoryId,
    policy,
    source,
    revision: 1,
    expectedRevision: 0,
    expectedRegistryVersion: 0,
    definitionDigest: 'a'.repeat(64),
    status: 'draft',
    activeRevision: null,
    snapshot: sealed({ [userId]: Buffer.alloc(32, 7).toString('base64') }),
    githubToken: 'github-test-token',
    ...options,
  });
async function addMember(user: string, account: string) {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO billing_accounts(id,workos_client_id,workos_user_id,sync_account_id,generation,lifecycle,created_at,updated_at) VALUES(?,?,?, ?,1,'active',?,?)`,
    )
    .bind(`billing_${account}`, 'client_factory_test', user, account, now, now)
    .run();
  await db
    .prepare(
      `INSERT INTO hosted_organization_memberships(organization_id,billing_account_id,workos_client_id,workos_user_id,email,workos_membership_id,workos_sync_status,role,status,seat_opted_out,created_at,updated_at) VALUES(?,?,?,?,'member@example.test',?,'synced','member','active',0,?,?)`,
    )
    .bind(
      organizationId,
      `billing_${account}`,
      'client_factory_test',
      user,
      `membership_${account}`,
      now,
      now,
    )
    .run();
}

describe('hosted organisation factories', () => {
  it('requires current organization membership and keeps recipient keys stable', async () => {
    const publicKey = Buffer.alloc(32, 7).toString('base64');
    expect(
      (
        await call(
          'factory.key.register',
          { organizationId, publicKey, githubToken: 'github-test-token' },
          { accountId: auth.accountId, enrollmentId: 'same-account-second-device' },
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await call('factory.key.register', {
          organizationId,
          publicKey,
          githubToken: 'github-test-token',
        })
      ).ok,
    ).toBe(true);
    const members = await call('factory.members', { organizationId });
    expect((members.body.members as Array<{ userId: string; publicKey: string }>)[0]).toMatchObject(
      { userId, publicKey },
    );
    const conflict = await call('factory.key.register', {
      organizationId,
      publicKey: Buffer.alloc(32, 8).toString('base64'),
      githubToken: 'github-test-token',
    });
    expect(conflict.ok).toBe(false);
    await db
      .prepare(
        "UPDATE hosted_organization_memberships SET status='inactive' WHERE organization_id=?",
      )
      .bind(organizationId)
      .run();
    expect((await call('factory.members', { organizationId })).ok).toBe(false);
  });

  it('omits deleted Sync accounts from future recipient rosters even before WorkOS membership sync', async () => {
    const deletedUser = 'workos_factory_deleted',
      deletedAccount = 'sync_factory_deleted';
    await addMember(deletedUser, deletedAccount);
    await call(
      'factory.key.register',
      {
        organizationId,
        publicKey: Buffer.alloc(32, 15).toString('base64'),
        githubToken: 'github-test-token',
      },
      { accountId: deletedAccount, enrollmentId: 'device_factory_deleted' },
    );
    await db
      .prepare("UPDATE billing_accounts SET lifecycle='deleted' WHERE sync_account_id=?")
      .bind(deletedAccount)
      .run();
    const result = await call('factory.members', { organizationId });
    expect(
      (result.body.members as Array<{ userId: string }>).some(
        (item) => item.userId === deletedUser,
      ),
    ).toBe(false);
  });

  it('pins the GitHub source and rejects stale snapshot revisions and run versions', async () => {
    const publicKey = Buffer.alloc(32, 7).toString('base64');
    await call('factory.key.register', {
      organizationId,
      publicKey,
      githubToken: 'github-test-token',
    });
    const definitionDigest = 'a'.repeat(64),
      saved = await upsert('factory_test', {
        definitionDigest,
        snapshot: sealed({ [userId]: publicKey }),
      });
    expect(saved.ok).toBe(true);
    const changedSource = await call('factory.registry.upsert', {
      factoryId: 'factory_test',
      policy,
      source: { ...source, repo: 'other' },
      revision: 2,
      expectedRevision: 1,
      expectedRegistryVersion: 1,
      definitionDigest,
      status: 'draft',
      activeRevision: null,
      snapshot: sealed({ [userId]: publicKey }),
      githubToken: 'github-test-token',
    });
    expect(changedSource.ok).toBe(false);
    const snapshot = sealed({ [userId]: publicKey }),
      payloadDigest = 'e'.repeat(64);
    expect(
      (
        await call('factory.snapshot.publish', {
          factoryId: 'factory_test',
          revision: 1,
          runId: 'run_test',
          version: 1,
          payloadDigest,
          snapshot,
          githubToken: 'github-test-token',
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await call('factory.snapshot.publish', {
          factoryId: 'factory_test',
          revision: 1,
          runId: 'run_test',
          version: 2,
          payloadDigest: 'f'.repeat(64),
          snapshot,
          githubToken: 'github-test-token',
        })
      ).ok,
    ).toBe(true);
    const rewrap = await call('factory.snapshot.publish', {
      factoryId: 'factory_test',
      revision: 1,
      runId: 'run_test',
      version: 2,
      payloadDigest: 'f'.repeat(64),
      snapshot: { ...snapshot, ciphertext: Buffer.from('different').toString('base64') },
      githubToken: 'github-test-token',
    });
    expect(rewrap.ok).toBe(true);
    const changedPayload = await call('factory.snapshot.publish', {
      factoryId: 'factory_test',
      revision: 1,
      runId: 'run_test',
      version: 2,
      payloadDigest: 'g'.repeat(64),
      snapshot,
      githubToken: 'github-test-token',
    });
    expect(changedPayload.ok).toBe(false);
    const stale = await call('factory.snapshot.publish', {
      factoryId: 'factory_test',
      revision: 1,
      runId: 'run_test',
      version: 1,
      payloadDigest,
      snapshot,
      githubToken: 'github-test-token',
    });
    expect(stale.ok).toBe(false);
    const sourceChangedWithNewRevision = await call('factory.registry.upsert', {
      factoryId: 'factory_test',
      policy,
      source: { ...source, repo: 'other' },
      revision: 2,
      expectedRevision: 1,
      expectedRegistryVersion: 1,
      definitionDigest,
      status: 'draft',
      activeRevision: null,
      snapshot,
      githubToken: 'github-test-token',
    });
    expect(sourceChangedWithNewRevision.ok).toBe(false);
  });

  it('enforces viewer and operator actions from current membership and role', async () => {
    const viewer = 'workos_factory_viewer',
      viewerAccount = 'sync_factory_viewer';
    await addMember(viewer, viewerAccount);
    const ownerPub = Buffer.alloc(32, 7).toString('base64'),
      viewerPub = Buffer.alloc(32, 9).toString('base64');
    await call('factory.key.register', {
      organizationId,
      publicKey: ownerPub,
      githubToken: 'github-test-token',
    });
    await call(
      'factory.key.register',
      { organizationId, publicKey: viewerPub, githubToken: 'github-test-token' },
      { accountId: viewerAccount, enrollmentId: 'device_factory_viewer' },
    );
    const viewerPolicy = { ...policy, members: [{ userId: viewer, role: 'viewer' }] };
    const digest = 'b'.repeat(64);
    await call('factory.registry.upsert', {
      factoryId: 'factory_roles',
      policy: viewerPolicy,
      source,
      revision: 1,
      expectedRevision: 0,
      expectedRegistryVersion: 0,
      definitionDigest: digest,
      status: 'active',
      activeRevision: 1,
      snapshot: sealed({ [userId]: ownerPub, [viewer]: viewerPub }),
      githubToken: 'github-test-token',
    });
    const viewerRead = await call(
      'factory.registry.read',
      { factoryId: 'factory_roles', githubToken: 'github-test-token' },
      { accountId: viewerAccount, enrollmentId: 'device_factory_viewer' },
    );
    expect(viewerRead.ok).toBe(true);
    expect((viewerRead.body.snapshot as { keys: Record<string, unknown> }).keys).toEqual({
      [viewer]: expect.any(Object),
    });
    const denied = await call(
      'factory.command.send',
      {
        factoryId: 'factory_roles',
        githubToken: 'github-test-token',
        command: { id: 'viewer-pause', action: 'pause' },
      },
      { accountId: viewerAccount, enrollmentId: 'device_factory_viewer' },
    );
    expect(denied.ok).toBe(false);
    const inactive = 'workos_factory_removed';
    await addMember(inactive, 'sync_factory_removed');
    await db
      .prepare(
        "UPDATE hosted_organization_memberships SET status='inactive' WHERE organization_id=? AND workos_user_id=?",
      )
      .bind(organizationId, inactive)
      .run();
    expect(
      (
        await call(
          'factory.registry.read',
          { factoryId: 'factory_roles', githubToken: 'github-test-token' },
          { accountId: 'sync_factory_removed', enrollmentId: 'device_factory_removed' },
        )
      ).ok,
    ).toBe(false);
  });

  it('lets operators pause but blocks merge authority and binds execution to one enrollment', async () => {
    const operator = 'workos_factory_operator',
      operatorAccount = 'sync_factory_operator';
    await addMember(operator, operatorAccount);
    const ownerPub = Buffer.alloc(32, 7).toString('base64'),
      operatorPub = Buffer.alloc(32, 10).toString('base64');
    await call('factory.key.register', {
      organizationId,
      publicKey: ownerPub,
      githubToken: 'github-test-token',
    });
    await call(
      'factory.key.register',
      { organizationId, publicKey: operatorPub, githubToken: 'github-test-token' },
      { accountId: operatorAccount, enrollmentId: 'device_factory_operator' },
    );
    const rolePolicy = { ...policy, members: [{ userId: operator, role: 'operator' }] },
      digest = 'c'.repeat(64);
    await call('factory.registry.upsert', {
      factoryId: 'factory_operator',
      policy: rolePolicy,
      source,
      revision: 1,
      expectedRevision: 0,
      expectedRegistryVersion: 0,
      definitionDigest: digest,
      status: 'active',
      activeRevision: 1,
      snapshot: sealed({ [userId]: ownerPub, [operator]: operatorPub }),
      githubToken: 'github-test-token',
    });
    const pause = await call(
      'factory.command.send',
      {
        factoryId: 'factory_operator',
        githubToken: 'github-test-token',
        command: { id: 'operator-pause', action: 'pause' },
      },
      { accountId: operatorAccount, enrollmentId: 'device_factory_operator' },
    );
    expect(pause.ok).toBe(true);
    const merge = await call(
      'factory.command.send',
      {
        factoryId: 'factory_operator',
        githubToken: 'github-test-token',
        command: {
          id: 'operator-merge',
          action: 'approve-merge',
          runId: 'run_missing',
          expectedHeadSha: 'a'.repeat(40),
        },
      },
      { accountId: operatorAccount, enrollmentId: 'device_factory_operator' },
    );
    expect(merge.ok).toBe(false);
    const otherDevice = await call(
      'factory.registry.authorize',
      {
        factoryId: 'factory_operator',
        action: 'execute',
        expectedRegistryVersion: 1,
        githubToken: 'github-test-token',
      },
      { accountId: auth.accountId, enrollmentId: 'second_device' },
    );
    expect(otherDevice.ok).toBe(false);
  });

  it('keeps organization-wide discovery while redacting repositories from users without source access', async () => {
    const digest = 'd'.repeat(64);
    const ownerPub = Buffer.alloc(32, 7).toString('base64');
    await call('factory.key.register', {
      organizationId,
      publicKey: ownerPub,
      githubToken: 'github-test-token',
    });
    await call('factory.registry.upsert', {
      factoryId: 'factory_redacted',
      policy,
      source,
      revision: 1,
      expectedRevision: 0,
      expectedRegistryVersion: 0,
      definitionDigest: digest,
      status: 'active',
      activeRevision: 1,
      snapshot: sealed({ [userId]: ownerPub }),
      githubToken: 'github-test-token',
    });
    github.mockImplementation(async (url: string | URL) =>
      String(url).includes('/repos/')
        ? Response.json({ full_name: 'acme/mezair', private: true, permissions: { pull: false } })
        : Response.json({ login: 'factory-owner' }),
    );
    const result = await call('factory.registry.list', { githubToken: 'github-other-token' });
    const row = (result.body.factories as Array<Record<string, unknown>>).find(
      (item) => item.id === 'factory_redacted',
    );
    expect(row).toMatchObject({ id: 'factory_redacted', accessRequired: true, role: 'owner' });
    expect(row).not.toHaveProperty('source');
    expect(row).not.toHaveProperty('status');
    expect(row).toHaveProperty('snapshot', null);
  });

  it('wraps restricted factory keys only for named members and organization owners', async () => {
    const memberId = 'workos_factory_named',
      memberAccount = 'sync_factory_named';
    await addMember(memberId, memberAccount);
    const ownerPub = Buffer.alloc(32, 7).toString('base64'),
      memberPub = Buffer.alloc(32, 8).toString('base64');
    await call('factory.key.register', {
      organizationId,
      publicKey: ownerPub,
      githubToken: 'github-test-token',
    });
    await call(
      'factory.key.register',
      { organizationId, publicKey: memberPub, githubToken: 'github-test-token' },
      { accountId: memberAccount, enrollmentId: 'device_factory_named' },
    );
    const restricted = {
      ...policy,
      visibility: 'restricted',
      members: [{ userId: memberId, role: 'viewer' }],
    };
    const snapshot = sealed({ [userId]: ownerPub, [memberId]: memberPub });
    const created = await call('factory.registry.upsert', {
      factoryId: 'factory_restricted',
      policy: restricted,
      source,
      revision: 1,
      expectedRevision: 0,
      expectedRegistryVersion: 0,
      definitionDigest: '9'.repeat(64),
      status: 'draft',
      activeRevision: null,
      snapshot,
      githubToken: 'github-test-token',
    });
    expect(created.ok).toBe(true);
    const recipients = await call('factory.members', {
      organizationId,
      factoryId: 'factory_restricted',
      policy: restricted,
      source,
      githubToken: 'github-test-token',
    });
    expect(
      (recipients.body.members as Array<{ userId: string }>).map((x) => x.userId).sort(),
    ).toEqual([memberId, userId].sort());
    const leaked = await call('factory.registry.upsert', {
      factoryId: 'factory_restricted',
      policy: restricted,
      source,
      revision: 1,
      expectedRevision: 0,
      expectedRegistryVersion: 0,
      definitionDigest: '9'.repeat(64),
      status: 'draft',
      activeRevision: null,
      snapshot: sealed({
        [userId]: ownerPub,
        [memberId]: memberPub,
        ...{ another: 'A'.repeat(44) },
      }),
      githubToken: 'github-test-token',
    });
    expect(leaked.ok).toBe(false);
  });

  it('revokes queued controls after membership changes and fences command leases', async () => {
    const operator = 'workos_factory_operator_queue',
      operatorAccount = 'sync_factory_operator_queue';
    await addMember(operator, operatorAccount);
    const ownerPub = Buffer.alloc(32, 7).toString('base64'),
      operatorPub = Buffer.alloc(32, 11).toString('base64');
    await call('factory.key.register', {
      organizationId,
      publicKey: ownerPub,
      githubToken: 'github-test-token',
    });
    await call(
      'factory.key.register',
      { organizationId, publicKey: operatorPub, githubToken: 'github-test-token' },
      { accountId: operatorAccount, enrollmentId: 'device_factory_operator_queue' },
    );
    const rolePolicy = { ...policy, members: [{ userId: operator, role: 'operator' }] };
    await call('factory.registry.upsert', {
      factoryId: 'factory_queue',
      policy: rolePolicy,
      source,
      revision: 1,
      expectedRevision: 0,
      expectedRegistryVersion: 0,
      definitionDigest: 'b'.repeat(64),
      status: 'active',
      activeRevision: 1,
      snapshot: sealed({ [userId]: ownerPub, [operator]: operatorPub }),
      githubToken: 'github-test-token',
    });
    const queued = await call(
      'factory.command.send',
      {
        factoryId: 'factory_queue',
        githubToken: 'github-test-token',
        command: { id: 'queued-before-revoke', action: 'pause' },
      },
      { accountId: operatorAccount, enrollmentId: 'device_factory_operator_queue' },
    );
    expect(queued.ok).toBe(true);
    await db
      .prepare(
        "UPDATE hosted_organization_memberships SET status='inactive' WHERE organization_id=? AND workos_user_id=?",
      )
      .bind(organizationId, operator)
      .run();
    const taken = await call('factory.command.take', {
      factoryId: 'factory_queue',
      githubToken: 'github-test-token',
    });
    expect(taken.body.commands).toEqual([]);
    const state = await db
      .prepare('SELECT state FROM hosted_factory_commands WHERE id=?')
      .bind('queued-before-revoke')
      .first<{ state: string }>();
    expect(state?.state).toBe('revoked');
  });

  it('denies cross-factory runs and requires current authoritative registry state for execution', async () => {
    const ownerPub = Buffer.alloc(32, 7).toString('base64');
    await call('factory.key.register', {
      organizationId,
      publicKey: ownerPub,
      githubToken: 'github-test-token',
    });
    for (const factoryId of ['factory_run_a', 'factory_run_b'])
      await call('factory.registry.upsert', {
        factoryId,
        policy,
        source,
        revision: 1,
        expectedRevision: 0,
        expectedRegistryVersion: 0,
        definitionDigest: 'c'.repeat(64),
        status: 'active',
        activeRevision: 1,
        snapshot: sealed({ [userId]: ownerPub }),
        githubToken: 'github-test-token',
      });
    const snapshot = sealed({ [userId]: ownerPub });
    expect(
      (
        await call('factory.snapshot.publish', {
          factoryId: 'factory_run_a',
          revision: 1,
          runId: 'run_only_a',
          version: 1,
          payloadDigest: 'd'.repeat(64),
          snapshot,
          githubToken: 'github-test-token',
        })
      ).ok,
    ).toBe(true);
    const crossFactory = await call('factory.command.send', {
      factoryId: 'factory_run_b',
      githubToken: 'github-test-token',
      command: { id: 'cross-factory-run', action: 'cancel', runId: 'run_only_a' },
    });
    expect(crossFactory.ok).toBe(false);
    expect(
      (
        await call('factory.registry.authorize', {
          factoryId: 'factory_run_b',
          action: 'execute',
          expectedRegistryVersion: 0,
          githubToken: 'github-test-token',
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await call('factory.registry.authorize', {
          factoryId: 'factory_run_b',
          action: 'execute',
          expectedRegistryVersion: 1,
          githubToken: 'github-test-token',
        })
      ).ok,
    ).toBe(true);
    await call('factory.registry.upsert', {
      factoryId: 'factory_run_b',
      policy,
      source,
      revision: 1,
      expectedRevision: 1,
      expectedRegistryVersion: 1,
      definitionDigest: 'c'.repeat(64),
      status: 'paused',
      activeRevision: 1,
      snapshot,
      githubToken: 'github-test-token',
    });
    expect(
      (
        await call('factory.registry.authorize', {
          factoryId: 'factory_run_b',
          action: 'execute',
          expectedRegistryVersion: 2,
          githubToken: 'github-test-token',
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await call('factory.registry.authorize', {
          factoryId: 'factory_run_b',
          action: 'cancel',
          expectedRegistryVersion: 2,
          githubToken: 'github-test-token',
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await call('factory.registry.upsert', {
          factoryId: 'factory_run_b',
          policy,
          source,
          revision: 1,
          expectedRevision: 1,
          expectedRegistryVersion: 1,
          definitionDigest: 'c'.repeat(64),
          status: 'active',
          activeRevision: 1,
          snapshot,
          githubToken: 'github-test-token',
        })
      ).ok,
    ).toBe(false);
  });

  it('uses verified team membership for team audiences and rejects revoked source access at command claim', async () => {
    const member = 'workos_factory_team',
      account = 'sync_factory_team';
    await addMember(member, account);
    const ownerPub = Buffer.alloc(32, 7).toString('base64'),
      memberPub = Buffer.alloc(32, 12).toString('base64');
    await call('factory.key.register', {
      organizationId,
      publicKey: ownerPub,
      githubToken: 'github-test-token',
    });
    await call(
      'factory.key.register',
      { organizationId, publicKey: memberPub, githubToken: 'github-test-token' },
      { accountId: account, enrollmentId: 'device_factory_team' },
    );
    const teamPolicy = { ...policy, visibility: 'team', teamId: 'platform', members: [] };
    const saved = await call('factory.registry.upsert', {
      factoryId: 'factory_team',
      policy: teamPolicy,
      source,
      revision: 1,
      expectedRevision: 0,
      expectedRegistryVersion: 0,
      definitionDigest: 'f'.repeat(64),
      status: 'active',
      activeRevision: 1,
      snapshot: sealed({ [userId]: ownerPub, [member]: memberPub }),
      githubToken: 'github-test-token',
    });
    expect(saved.ok).toBe(true);
    const recipients = await call('factory.members', {
      organizationId,
      factoryId: 'factory_team',
      policy: teamPolicy,
      source,
      githubToken: 'github-test-token',
    });
    expect((recipients.body.members as Array<{ userId: string }>).map((x) => x.userId)).toContain(
      member,
    );
    const send = await call('factory.command.send', {
      factoryId: 'factory_team',
      githubToken: 'github-test-token',
      command: { id: 'team-revoked-control', action: 'pause' },
    });
    expect(send.ok).toBe(true);
    privateRepo = true;
    denyCollaborator = true;
    const take = await call('factory.command.take', {
      factoryId: 'factory_team',
      githubToken: 'github-test-token',
    });
    expect(take.body.commands).toEqual([]);
    const row = await db
      .prepare('SELECT state FROM hosted_factory_commands WHERE id=?')
      .bind('team-revoked-control')
      .first<{ state: string }>();
    expect(row?.state).toBe('revoked');
  });

  it('deduplicates commands and fences completion with the active lease token', async () => {
    const ownerPub = Buffer.alloc(32, 7).toString('base64');
    await call('factory.key.register', {
      organizationId,
      publicKey: ownerPub,
      githubToken: 'github-test-token',
    });
    await call('factory.registry.upsert', {
      factoryId: 'factory_lease',
      policy,
      source,
      revision: 1,
      expectedRevision: 0,
      expectedRegistryVersion: 0,
      definitionDigest: '8'.repeat(64),
      status: 'active',
      activeRevision: 1,
      snapshot: sealed({ [userId]: ownerPub }),
      githubToken: 'github-test-token',
    });
    const command = { id: 'lease-command', action: 'pause' };
    expect(
      (
        await call('factory.command.send', {
          factoryId: 'factory_lease',
          githubToken: 'github-test-token',
          command,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await call('factory.command.send', {
          factoryId: 'factory_lease',
          githubToken: 'github-test-token',
          command,
        })
      ).ok,
    ).toBe(true);
    const first = await call('factory.command.take', {
      factoryId: 'factory_lease',
      githubToken: 'github-test-token',
    });
    const claimed = (first.body.commands as Array<{ leaseToken: string }>)[0];
    expect(claimed.leaseToken).toEqual(expect.any(String));
    expect(
      (
        await call('factory.command.take', {
          factoryId: 'factory_lease',
          githubToken: 'github-test-token',
        })
      ).body.commands,
    ).toEqual([]);
    const completed = await call('factory.command.complete', {
      factoryId: 'factory_lease',
      commandId: 'lease-command',
      leaseToken: claimed.leaseToken,
      ok: true,
      githubToken: 'github-test-token',
    });
    expect(completed.ok).toBe(true);
    expect(
      (
        await call('factory.command.complete', {
          factoryId: 'factory_lease',
          commandId: 'lease-command',
          leaseToken: claimed.leaseToken,
          ok: true,
          githubToken: 'github-test-token',
        })
      ).ok,
    ).toBe(false);
  });

  it('atomically widens the audience and rewraps an immutable historical run for newly eligible members', async () => {
    const member = 'workos_factory_history',
      account = 'sync_factory_history';
    await addMember(member, account);
    const ownerPub = Buffer.alloc(32, 7).toString('base64'),
      memberPub = Buffer.alloc(32, 13).toString('base64');
    await call('factory.key.register', {
      organizationId,
      publicKey: ownerPub,
      githubToken: 'github-test-token',
    });
    await call(
      'factory.key.register',
      { organizationId, publicKey: memberPub, githubToken: 'github-test-token' },
      { accountId: account, enrollmentId: 'device_factory_history' },
    );
    const restricted = { ...policy, visibility: 'restricted', members: [] };
    await call('factory.registry.upsert', {
      factoryId: 'factory_history',
      policy: restricted,
      source,
      revision: 1,
      expectedRevision: 0,
      expectedRegistryVersion: 0,
      definitionDigest: '1'.repeat(64),
      status: 'active',
      activeRevision: 1,
      snapshot: sealed({ [userId]: ownerPub }),
      githubToken: 'github-test-token',
    });
    const payloadDigest = '2'.repeat(64);
    await call('factory.snapshot.publish', {
      factoryId: 'factory_history',
      revision: 1,
      runId: 'historical_run',
      version: 1,
      payloadDigest,
      snapshot: sealed({ [userId]: ownerPub }),
      githubToken: 'github-test-token',
    });
    const widened = { ...policy, visibility: 'organization', members: [] };
    const updated = await call('factory.registry.upsert', {
      factoryId: 'factory_history',
      policy: widened,
      source,
      revision: 2,
      expectedRevision: 1,
      expectedRegistryVersion: 1,
      definitionDigest: '3'.repeat(64),
      status: 'active',
      activeRevision: 2,
      snapshot: sealed({ [userId]: ownerPub, [member]: memberPub }),
      githubToken: 'github-test-token',
    });
    expect(updated.ok).toBe(true);
    const before = await call(
      'factory.run.read',
      { factoryId: 'factory_history', runId: 'historical_run', githubToken: 'github-test-token' },
      { accountId: account, enrollmentId: 'device_factory_history' },
    );
    expect((before.body.runs as Array<{ accessPending: boolean }>)[0].accessPending).toBe(true);
    const history = await call('factory.snapshot.publish', {
      factoryId: 'factory_history',
      revision: 2,
      runId: 'historical_run',
      version: 1,
      payloadDigest,
      snapshot: sealed({ [userId]: ownerPub, [member]: memberPub }),
      githubToken: 'github-test-token',
    });
    expect(history.ok).toBe(true);
    const after = await call(
      'factory.run.read',
      { factoryId: 'factory_history', runId: 'historical_run', githubToken: 'github-test-token' },
      { accountId: account, enrollmentId: 'device_factory_history' },
    );
    expect(after.body.runs).toMatchObject([
      {
        id: 'historical_run',
        version: 1,
        accessPending: false,
        snapshot: { keys: { [member]: expect.any(Object) } },
      },
    ]);
  });

  it('routes snapshot envelope rewrap through the public RPC operation inventory', async () => {
    expect(OPERATIONS).toContain('factory.snapshot.rewrap');
    expect(OPERATION_PROFILE['factory.snapshot.rewrap']).toBe('sync/2');
    expect(OPERATION_ROLE['factory.snapshot.rewrap']).toBe('user');
    expect(HOSTED_OPERATION_CLASS['factory.snapshot.rewrap']).toBe('mutating');
    env.MEZAIR_DEV_SPIKE = 'true';
    try {
      const result = await postRpc(
        'factory.snapshot.rewrap',
        {},
        spikeBearer(auth.accountId, auth.enrollmentId),
      );
      expect(isRpcError(result.body) ? result.body.error.code : undefined).toBe(
        'malformed-request',
      );
    } finally {
      env.MEZAIR_DEV_SPIKE = undefined;
    }
  });

  it('completes create, read, activate, rewrap, and run-version delivery through authenticated RPC', async () => {
    const member = 'workos_factory_rpc',
      account = 'sync_factory_rpc';
    await addMember(member, account);
    const ownerPub = Buffer.alloc(32, 7).toString('base64'),
      memberPub = Buffer.alloc(32, 14).toString('base64');
    const rpc = async (
      operation: string,
      params: Record<string, unknown>,
      who: { accountId: string; enrollmentId: string } = auth,
    ) => {
      const response = await postRpc(
        operation,
        params,
        spikeBearer(who.accountId, who.enrollmentId),
      );
      if (isRpcError(response.body)) throw new Error(`${operation}: ${response.body.error.code}`);
      return response.body.result as Record<string, unknown>;
    };
    env.MEZAIR_DEV_SPIKE = 'true';
    try {
      await rpc('factory.key.register', {
        organizationId,
        publicKey: ownerPub,
        githubToken: 'github-test-token',
      });
      await rpc(
        'factory.key.register',
        { organizationId, publicKey: memberPub, githubToken: 'github-test-token' },
        { accountId: account, enrollmentId: 'device_factory_rpc' },
      );
      const snapshot = sealed({ [userId]: ownerPub, [member]: memberPub });
      const created = await rpc('factory.registry.upsert', {
        factoryId: 'factory_rpc_flow',
        policy,
        source,
        revision: 1,
        expectedRevision: 0,
        expectedRegistryVersion: 0,
        definitionDigest: '4'.repeat(64),
        status: 'draft',
        activeRevision: null,
        snapshot,
        githubToken: 'github-test-token',
      });
      expect(created.registryVersion).toBe(1);
      const read = await rpc('factory.registry.read', {
        factoryId: 'factory_rpc_flow',
        githubToken: 'github-test-token',
      });
      expect(read).toMatchObject({ revision: 1, registryVersion: 1, status: 'draft' });
      const activated = await rpc('factory.registry.upsert', {
        factoryId: 'factory_rpc_flow',
        policy,
        source,
        revision: 1,
        expectedRevision: 1,
        expectedRegistryVersion: 1,
        definitionDigest: '4'.repeat(64),
        status: 'active',
        activeRevision: 1,
        snapshot,
        githubToken: 'github-test-token',
      });
      expect(activated.registryVersion).toBe(2);
      const rewrapped = await rpc('factory.snapshot.rewrap', {
        factoryId: 'factory_rpc_flow',
        revision: 1,
        registryVersion: 2,
        definitionDigest: '4'.repeat(64),
        snapshot,
        githubToken: 'github-test-token',
      });
      expect(rewrapped.registryVersion).toBe(2);
      await rpc('factory.snapshot.publish', {
        factoryId: 'factory_rpc_flow',
        revision: 1,
        runId: 'rpc_run',
        version: 1,
        payloadDigest: '5'.repeat(64),
        snapshot,
        githubToken: 'github-test-token',
      });
      await rpc('factory.snapshot.publish', {
        factoryId: 'factory_rpc_flow',
        revision: 1,
        runId: 'rpc_run',
        version: 2,
        payloadDigest: '6'.repeat(64),
        snapshot,
        githubToken: 'github-test-token',
      });
      await rpc('factory.snapshot.publish', {
        factoryId: 'factory_rpc_flow',
        revision: 1,
        runId: 'rpc_run',
        version: 2,
        payloadDigest: '6'.repeat(64),
        snapshot: { ...snapshot, ciphertext: Buffer.from('rewrapped').toString('base64') },
        githubToken: 'github-test-token',
      });
      const history = await rpc(
        'factory.run.read',
        { factoryId: 'factory_rpc_flow', runId: 'rpc_run', githubToken: 'github-test-token' },
        { accountId: account, enrollmentId: 'device_factory_rpc' },
      );
      expect(history.runs).toMatchObject([
        {
          id: 'rpc_run',
          version: 2,
          accessPending: false,
          snapshot: { keys: { [member]: expect.any(Object) } },
        },
      ]);
    } finally {
      env.MEZAIR_DEV_SPIKE = undefined;
    }
  });
});

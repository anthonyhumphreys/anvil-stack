import type { VerifiedAuth } from '../auth';
import { isRecord, rpcErrorResponse } from '../rpc';
import type {
  FactoryDirectoryEntry,
  FactorySource,
  OrganizationFactoryPolicy,
  OrganizationFactoryRole,
  SealedFactorySnapshot,
} from '../../../contract/factory-access';

interface Member {
  userId: string;
  accountId: string;
  role: string;
}
interface Row {
  id: string;
  organization_id: string;
  owner_id: string;
  executor_account_id: string;
  executor_enrollment_id: string;
  revision: number;
  registry_version: number;
  policy_json: string;
  source_json: string;
  definition_digest: string;
  status: string;
  active_revision: number | null;
  activated_at: string | null;
  snapshot_json: string | null;
  updated_at: number;
}
const deny = () => rpcErrorResponse(undefined, 'forbidden');
const malformed = () => rpcErrorResponse(undefined, 'malformed-request');
const id = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(x);
const roles = ['viewer', 'operator', 'owner'];
const response = (value: unknown) =>
  Response.json(value, { headers: { 'cache-control': 'private, no-store' } });

async function member(
  db: D1Database,
  accountId: string,
  organizationId: string,
): Promise<Member | null> {
  return db
    .prepare(
      `SELECT b.workos_user_id AS userId,b.sync_account_id AS accountId,m.role
    FROM billing_accounts b JOIN hosted_organization_memberships m ON m.billing_account_id=b.id
    JOIN hosted_organizations o ON o.id=m.organization_id
    WHERE b.sync_account_id=? AND b.lifecycle='active' AND m.organization_id=?
    AND m.status='active' AND m.workos_sync_status='synced' AND o.status='active'
    AND m.workos_client_id=b.workos_client_id AND m.workos_user_id=b.workos_user_id`,
    )
    .bind(accountId, organizationId)
    .first<Member>();
}
function policy(value: unknown): value is OrganizationFactoryPolicy {
  if (
    !isRecord(value) ||
    !id(value.organizationId) ||
    !['organization', 'team', 'restricted'].includes(String(value.visibility)) ||
    !Array.isArray(value.members) ||
    value.members.length > 100
  )
    return false;
  if (
    value.visibility === 'team' &&
    (typeof value.teamId !== 'string' || !/^[a-z0-9-]{1,100}$/i.test(value.teamId))
  )
    return false;
  return (
    value.members.every((x) => isRecord(x) && id(x.userId) && roles.includes(String(x.role))) &&
    new Set(value.members.map((x) => (x as { userId: string }).userId)).size ===
      value.members.length
  );
}
function source(value: unknown): value is FactorySource {
  return (
    isRecord(value) &&
    value.host === 'github.com' &&
    typeof value.owner === 'string' &&
    /^[a-z0-9_.-]{1,100}$/i.test(value.owner) &&
    typeof value.repo === 'string' &&
    /^[a-z0-9_.-]{1,100}$/i.test(value.repo)
  );
}
/** No provider credential is ever persisted, included in a receipt, or returned. */
async function sourceAccess(src: FactorySource, token: unknown, team?: string): Promise<boolean> {
  if (typeof token !== 'string' || token.length < 10 || token.length > 4096 || /\s/.test(token))
    return false;
  const get = async (path: string) =>
    fetch(`https://api.github.com${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'Anvil-factory-access',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
  try {
    const repo = await get(`/repos/${src.owner}/${src.repo}`);
    if (!repo.ok) return false;
    const data = (await repo.json()) as { full_name?: string; permissions?: { pull?: boolean } };
    if (
      data.full_name?.toLowerCase() !== `${src.owner}/${src.repo}`.toLowerCase() ||
      data.permissions?.pull !== true
    )
      return false;
    if (team) {
      const user = await get('/user');
      if (!user.ok) return false;
      const identity = (await user.json()) as { login?: string };
      if (!identity.login) return false;
      const result = await get(
        `/orgs/${src.owner}/teams/${team}/memberships/${encodeURIComponent(identity.login)}`,
      );
      if (!result.ok) return false;
      const membership = (await result.json()) as { state?: string };
      if (membership.state !== 'active') return false;
    }
    return true;
  } catch {
    return false;
  }
}
async function githubRead(token: unknown, path: string): Promise<Record<string, unknown> | null> {
  if (typeof token !== 'string' || token.length < 10 || token.length > 4096 || /\s/.test(token))
    return null;
  try {
    const result = await fetch(`https://api.github.com${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'Anvil-factory-access',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    return result.ok ? ((await result.json()) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
async function githubLogin(token: unknown): Promise<string | null> {
  const user = await githubRead(token, '/user');
  return typeof user?.login === 'string' && /^[a-z0-9-]{1,100}$/i.test(user.login)
    ? user.login
    : null;
}
async function actorSourceAccess(
  src: FactorySource,
  token: unknown,
  login: unknown,
  team?: string,
): Promise<boolean> {
  if (typeof login !== 'string' || !/^[a-z0-9-]{1,100}$/i.test(login)) return false;
  const repo = await githubRead(token, `/repos/${src.owner}/${src.repo}`);
  if (!repo) return false;
  if (repo.private !== false) {
    const permission = await githubRead(
      token,
      `/repos/${src.owner}/${src.repo}/collaborators/${encodeURIComponent(login)}/permission`,
    );
    if (
      !permission ||
      !['read', 'triage', 'write', 'maintain', 'admin'].includes(String(permission.permission))
    )
      return false;
  }
  if (team) {
    const membership = await githubRead(
      token,
      `/orgs/${src.owner}/teams/${team}/memberships/${encodeURIComponent(login)}`,
    );
    if (membership?.state !== 'active') return false;
  }
  return true;
}
function roleFor(row: Row, m: Member): OrganizationFactoryRole | null {
  const access = JSON.parse(row.policy_json) as OrganizationFactoryPolicy;
  if (m.role === 'owner' || row.owner_id === m.userId) return 'owner';
  const assigned = access.members.find((x) => x.userId === m.userId)?.role;
  if (assigned) return assigned;
  return access.visibility === 'restricted' ? null : 'viewer';
}
function permitted(role: OrganizationFactoryRole, action: string) {
  return (
    action === 'read' ||
    action === 'read-source' ||
    (['operate', 'cancel'].includes(action) && role !== 'viewer') ||
    (['edit', 'activate', 'merge'].includes(action) && role === 'owner')
  );
}
function validSnapshot(value: unknown): value is SealedFactorySnapshot {
  if (
    !isRecord(value) ||
    typeof value.ciphertext !== 'string' ||
    value.ciphertext.length > 600000 ||
    typeof value.nonce !== 'string' ||
    typeof value.tag !== 'string' ||
    !isRecord(value.keys) ||
    Object.keys(value.keys).length > 100
  )
    return false;
  const b64 = (x: unknown, max: number) =>
    typeof x === 'string' && x.length > 0 && x.length <= max && /^[A-Za-z0-9+/]+={0,2}$/.test(x);
  return (
    b64(value.ciphertext, 600000) &&
    b64(value.nonce, 32) &&
    b64(value.tag, 32) &&
    Object.entries(value.keys).every(
      ([user, wrap]) =>
        id(user) &&
        isRecord(wrap) &&
        b64(wrap.ephemeral, 100) &&
        b64(wrap.publicKey, 100) &&
        b64(wrap.nonce, 32) &&
        b64(wrap.tag, 32) &&
        b64(wrap.ciphertext, 100),
    )
  );
}
function recipientSnapshot(raw: string | null, userId: string): SealedFactorySnapshot | null {
  if (!raw) return null;
  const sealed = JSON.parse(raw) as SealedFactorySnapshot;
  const wrap = sealed.keys[userId];
  return wrap ? { ...sealed, keys: { [userId]: wrap } } : null;
}
async function audit(db: D1Database, factoryId: string, userId: string, action: string) {
  await db
    .prepare(
      'INSERT INTO hosted_factory_audit(id,factory_id,actor_id,action,created_at) VALUES(?,?,?,?,?)',
    )
    .bind(crypto.randomUUID(), factoryId, userId, action, Date.now())
    .run();
}

/** Called only after the router verifies the device bearer; params cannot supply actor identity. */
export async function handleFactoryOperation(
  operation: string,
  input: unknown,
  auth: VerifiedAuth,
  env: Env,
): Promise<Response> {
  const db = env.HOSTED_DB;
  if (!db || auth.enrollmentClass === 'ephemeral') return deny();
  if (!isRecord(input)) return malformed();
  if (operation === 'factory.organizations') {
    const rows = await db
      .prepare(
        `SELECT o.id AS id,m.role AS role FROM billing_accounts b JOIN hosted_organization_memberships m ON m.billing_account_id=b.id JOIN hosted_organizations o ON o.id=m.organization_id WHERE b.sync_account_id=? AND b.lifecycle='active' AND m.status='active' AND m.workos_sync_status='synced' AND o.status='active' ORDER BY o.name`,
      )
      .bind(auth.accountId)
      .all<{ id: string; role: string }>();
    return response({ organizations: rows.results ?? [] });
  }
  if (operation === 'factory.source.check') {
    if (!id(input.organizationId) || !source(input.source) || typeof input.teamId !== 'string')
      return malformed();
    const m = await member(db, auth.accountId, input.organizationId);
    if (!m || m.role !== 'owner') return deny();
    return response({ allowed: await sourceAccess(input.source, input.githubToken, input.teamId) });
  }
  if (operation === 'factory.key.register' || operation === 'factory.members') {
    if (!id(input.organizationId)) return malformed();
    const m = await member(db, auth.accountId, input.organizationId);
    if (!m) return deny();
    if (operation === 'factory.key.register') {
      if (typeof input.publicKey !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(input.publicKey))
        return malformed();
      const login = await githubLogin(input.githubToken);
      if (!login) return deny();
      const previous = await db
        .prepare('SELECT public_key FROM hosted_factory_keys WHERE organization_id=? AND user_id=?')
        .bind(input.organizationId, m.userId)
        .first<{ public_key: string }>();
      if (previous && previous.public_key !== input.publicKey)
        return rpcErrorResponse(undefined, 'conflict', {
          reason: 'factory-key-enrolled-on-another-device',
        });

      await db
        .prepare(
          'INSERT INTO hosted_factory_keys(organization_id,user_id,account_id,enrollment_id,public_key,github_login,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(organization_id,user_id) DO UPDATE SET account_id=excluded.account_id,enrollment_id=excluded.enrollment_id,public_key=excluded.public_key,github_login=excluded.github_login,updated_at=excluded.updated_at',
        )
        .bind(
          input.organizationId,
          m.userId,
          auth.accountId,
          auth.enrollmentId,
          input.publicKey,
          login,
          Date.now(),
        )
        .run();
      return response({ userId: m.userId });
    }
    let rows;
    if (input.factoryId !== undefined) {
      if (
        !id(input.factoryId) ||
        !policy(input.policy) ||
        !source(input.source) ||
        input.policy.organizationId !== input.organizationId
      )
        return malformed();
      const factory = await db
        .prepare('SELECT * FROM hosted_factories WHERE id=? AND organization_id=?')
        .bind(input.factoryId, input.organizationId)
        .first<Row>();
      if ((factory && roleFor(factory, m) !== 'owner') || (!factory && m.role !== 'owner'))
        return deny();
      if (
        factory &&
        JSON.stringify(input.source) !== JSON.stringify(JSON.parse(factory.source_json))
      )
        return deny();
      const eligible = await db
        .prepare(
          `SELECT m.workos_user_id AS userId,m.role,k.public_key AS publicKey,k.github_login AS githubLogin,b.sync_account_id AS accountId FROM hosted_organization_memberships m JOIN hosted_factory_keys k ON k.organization_id=m.organization_id AND k.user_id=m.workos_user_id JOIN billing_accounts b ON b.id=m.billing_account_id AND b.lifecycle='active' WHERE m.organization_id=? AND m.status='active' AND m.workos_sync_status='synced'`,
        )
        .bind(input.organizationId)
        .all<{
          userId: string;
          role: string;
          publicKey: string;
          githubLogin: string | null;
          accountId: string | null;
        }>();
      const p = input.policy as OrganizationFactoryPolicy;
      const selected = [];
      for (const recipient of eligible.results ?? []) {
        const privileged =
          recipient.role === 'owner' ||
          recipient.userId === factory?.owner_id ||
          recipient.accountId === factory?.executor_account_id ||
          recipient.accountId === auth.accountId;
        if (
          p.visibility === 'restricted' &&
          !p.members.some((x) => x.userId === recipient.userId) &&
          !privileged
        )
          continue;
        const team =
          p.visibility === 'team' &&
          !p.members.some((x) => x.userId === recipient.userId) &&
          !privileged
            ? p.teamId
            : undefined;
        if (
          !(await actorSourceAccess(
            input.source as FactorySource,
            input.githubToken,
            recipient.githubLogin,
            team,
          ))
        )
          continue;
        selected.push({
          userId: recipient.userId,
          role: recipient.role,
          publicKey: recipient.publicKey,
        });
      }
      rows = { results: selected };
    } else {
      rows = await db
        .prepare(
          `SELECT m.workos_user_id AS userId,m.role,k.public_key AS publicKey FROM hosted_organization_memberships m JOIN billing_accounts b ON b.id=m.billing_account_id AND b.lifecycle='active' LEFT JOIN hosted_factory_keys k ON k.organization_id=m.organization_id AND k.user_id=m.workos_user_id WHERE m.organization_id=? AND m.status='active' AND m.workos_sync_status='synced'`,
        )
        .bind(input.organizationId)
        .all();
    }
    return response({ members: rows.results });
  }
  if (operation === 'factory.registry.list') {
    const rows = await db
      .prepare(
        `SELECT f.* FROM hosted_factories f JOIN hosted_organization_memberships m ON m.organization_id=f.organization_id JOIN billing_accounts b ON b.id=m.billing_account_id WHERE b.sync_account_id=? AND b.lifecycle='active' AND m.status='active' ORDER BY f.updated_at DESC LIMIT 100`,
      )
      .bind(auth.accountId)
      .all<Row>();
    const entries: FactoryDirectoryEntry[] = [];
    for (const row of rows.results ?? []) {
      const m = await member(db, auth.accountId, row.organization_id),
        access = JSON.parse(row.policy_json) as OrganizationFactoryPolicy;
      if (!m) continue;
      const role = roleFor(row, m);
      if (!role) continue;
      if (
        !(await sourceAccess(
          JSON.parse(row.source_json) as FactorySource,
          input.githubToken,
          access.visibility === 'team' &&
            m.role !== 'owner' &&
            row.owner_id !== m.userId &&
            !access.members.some((x) => x.userId === m.userId)
            ? access.teamId
            : undefined,
        ))
      ) {
        if (access.visibility === 'organization')
          entries.push({
            id: row.id,
            revision: row.revision,
            registryVersion: row.registry_version,
            policy: {
              organizationId: row.organization_id,
              visibility: 'organization',
              members: [],
            },
            role,
            organizationAdmin: m.role === 'owner',
            executionOwner:
              auth.accountId === row.executor_account_id &&
              auth.enrollmentId === row.executor_enrollment_id,
            snapshot: null,
            accessPending: false,
            accessRequired: true,
          });
        continue;
      }
      const snapshot = recipientSnapshot(row.snapshot_json, m.userId);
      entries.push({
        id: row.id,
        revision: row.revision,
        registryVersion: row.registry_version,
        definitionDigest: row.definition_digest,
        policy: access,
        source: JSON.parse(row.source_json) as FactorySource,
        role,
        organizationAdmin: m.role === 'owner',
        executionOwner:
          auth.accountId === row.executor_account_id &&
          auth.enrollmentId === row.executor_enrollment_id,
        ownerId: row.owner_id,
        status: row.status as FactoryDirectoryEntry['status'],
        activeRevision: row.active_revision ?? undefined,
        activatedAt: row.activated_at,
        snapshot,
        accessPending: !snapshot,
        updatedAt: row.updated_at,
      });
    }
    return response({ factories: entries });
  }
  if (operation === 'factory.registry.upsert') {
    if (
      !id(input.factoryId) ||
      !policy(input.policy) ||
      !source(input.source) ||
      !Number.isSafeInteger(input.revision) ||
      Number(input.revision) < 1 ||
      !Number.isSafeInteger(input.expectedRevision) ||
      Number(input.expectedRevision) < 0 ||
      !Number.isSafeInteger(input.expectedRegistryVersion) ||
      Number(input.expectedRegistryVersion) < 0 ||
      typeof input.definitionDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(input.definitionDigest) ||
      !['draft', 'active', 'paused', 'inactive'].includes(String(input.status)) ||
      !validSnapshot(input.snapshot)
    )
      return malformed();
    const access: OrganizationFactoryPolicy = {
        organizationId: input.policy.organizationId,
        visibility: input.policy.visibility,
        ...(input.policy.teamId ? { teamId: input.policy.teamId } : {}),
        members: input.policy.members.map((x) => ({ userId: x.userId, role: x.role })),
      },
      canonicalSource: FactorySource = {
        host: input.source.host,
        owner: input.source.owner,
        repo: input.source.repo,
      },
      m = await member(db, auth.accountId, access.organizationId);
    if (!m) return deny();
    const existing = await db
      .prepare('SELECT * FROM hosted_factories WHERE id=?')
      .bind(input.factoryId)
      .first<Row>();
    if (
      existing &&
      (existing.organization_id !== access.organizationId || roleFor(existing, m) !== 'owner')
    )
      return deny();
    if (!existing && input.expectedRevision !== 0)
      return rpcErrorResponse(undefined, 'conflict', { reason: 'factory-revision-conflict' });
    if (
      existing &&
      JSON.stringify(JSON.parse(existing.source_json)) !== JSON.stringify(canonicalSource)
    )
      return rpcErrorResponse(undefined, 'conflict', { reason: 'factory-source-immutable' });
    if (!(await sourceAccess(canonicalSource, input.githubToken))) return deny();
    if (existing && input.expectedRevision !== existing.revision)
      return rpcErrorResponse(undefined, 'conflict');
    if (
      (existing && input.expectedRegistryVersion !== existing.registry_version) ||
      (!existing && input.expectedRegistryVersion !== 0)
    )
      return rpcErrorResponse(undefined, 'conflict', { reason: 'factory-state-version-conflict' });
    if (
      existing &&
      (Number(input.revision) < existing.revision ||
        Number(input.revision) > existing.revision + 1 ||
        (Number(input.revision) === existing.revision &&
          input.definitionDigest !== existing.definition_digest))
    )
      return rpcErrorResponse(undefined, 'conflict', { reason: 'factory-revision-conflict' });
    if (
      input.activeRevision !== undefined &&
      input.activeRevision !== null &&
      (!Number.isSafeInteger(input.activeRevision) ||
        Number(input.activeRevision) > Number(input.revision))
    )
      return malformed();
    if (
      (input.status === 'active' &&
        (input.activeRevision === null ||
          input.activeRevision === undefined ||
          Number(input.activeRevision) > Number(input.revision))) ||
      (existing && input.status !== 'active' && input.activeRevision !== existing.active_revision)
    )
      return rpcErrorResponse(undefined, 'conflict', { reason: 'invalid-active-revision' });
    const ownerId = existing?.owner_id ?? m.userId;
    for (const entry of access.members) {
      const active = await db
        .prepare(
          `SELECT 1 FROM hosted_organization_memberships WHERE organization_id=? AND workos_user_id=? AND status='active' AND workos_sync_status='synced'`,
        )
        .bind(access.organizationId, entry.userId)
        .first();
      if (!active) return deny();
    }
    for (const [userId, wrap] of Object.entries(input.snapshot.keys)) {
      const recipient = await db
        .prepare(
          `SELECT k.public_key,k.github_login,m.role,b.sync_account_id AS account_id FROM hosted_factory_keys k JOIN hosted_organization_memberships m ON m.organization_id=k.organization_id AND m.workos_user_id=k.user_id JOIN billing_accounts b ON b.id=m.billing_account_id AND b.lifecycle='active' WHERE k.organization_id=? AND k.user_id=? AND m.status='active' AND m.workos_sync_status='synced'`,
        )
        .bind(access.organizationId, userId)
        .first<{
          public_key: string;
          github_login: string | null;
          role: string;
          account_id: string | null;
        }>();
      if (recipient?.public_key !== wrap.publicKey) return deny();
      const explicit = access.members.some((x) => x.userId === userId),
        privileged =
          recipient.role === 'owner' ||
          userId === ownerId ||
          recipient.account_id === auth.accountId ||
          existing?.executor_account_id === recipient.account_id;
      if (access.visibility === 'restricted' && !explicit && !privileged) return deny();
      const team =
        access.visibility === 'team' && !explicit && !privileged ? access.teamId : undefined;
      if (
        !(await actorSourceAccess(canonicalSource, input.githubToken, recipient.github_login, team))
      )
        return deny();
    }
    const activeRevision =
        input.activeRevision === null || input.activeRevision === undefined
          ? null
          : Number(input.activeRevision),
      activatedAt =
        input.status === 'active'
          ? typeof input.activatedAt === 'string'
            ? input.activatedAt
            : (existing?.activated_at ?? new Date().toISOString())
          : (existing?.activated_at ?? null);
    const expectedState = Number(input.expectedRegistryVersion),
      nextState = expectedState + 1;
    const saved = await db
      .prepare(
        `INSERT INTO hosted_factories(id,organization_id,owner_id,executor_account_id,executor_enrollment_id,revision,registry_version,policy_json,source_json,definition_digest,status,active_revision,activated_at,snapshot_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,registry_version=hosted_factories.registry_version+1,policy_json=excluded.policy_json,definition_digest=excluded.definition_digest,status=excluded.status,active_revision=excluded.active_revision,activated_at=excluded.activated_at,snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at WHERE hosted_factories.revision=? AND hosted_factories.registry_version=?`,
      )
      .bind(
        input.factoryId,
        access.organizationId,
        ownerId,
        auth.accountId,
        auth.enrollmentId,
        input.revision,
        nextState,
        JSON.stringify(access),
        JSON.stringify(canonicalSource),
        input.definitionDigest,
        input.status,
        activeRevision,
        activatedAt,
        JSON.stringify(input.snapshot),
        Date.now(),
        existing?.revision ?? 0,
        expectedState,
      )
      .run();
    if (!saved.meta.changes) return rpcErrorResponse(undefined, 'conflict');
    await audit(db, input.factoryId, m.userId, 'configure');
    return response({
      role: 'owner',
      ownerId,
      revision: input.revision,
      registryVersion: nextState,
      definitionDigest: input.definitionDigest,
    });
  }
  if (!id(input.factoryId)) return malformed();
  const row = await db
    .prepare('SELECT * FROM hosted_factories WHERE id=?')
    .bind(input.factoryId)
    .first<Row>();
  if (!row) {
    if (
      operation === 'factory.registry.authorize' &&
      input.action === 'edit' &&
      policy(input.policy) &&
      source(input.source)
    ) {
      const creator = await member(db, auth.accountId, input.policy.organizationId);
      if (creator && (await sourceAccess(input.source, input.githubToken)))
        return response({
          role: 'owner',
          userId: creator.userId,
          organizationAdmin: creator.role === 'owner',
          executor: true,
        });
    }
    return deny();
  }
  const m = await member(db, auth.accountId, row.organization_id);
  if (!m) return deny();
  const access = JSON.parse(row.policy_json) as OrganizationFactoryPolicy,
    role = roleFor(row, m);
  if (!role) return deny();
  const src = JSON.parse(row.source_json) as FactorySource;
  if (
    !(await sourceAccess(
      src,
      input.githubToken,
      access.visibility === 'team' &&
        m.role !== 'owner' &&
        row.owner_id !== m.userId &&
        !access.members.some((x) => x.userId === m.userId)
        ? access.teamId
        : undefined,
    ))
  )
    return deny();
  if (operation === 'factory.registry.authorize') {
    const executionOwner =
      auth.accountId === row.executor_account_id &&
      auth.enrollmentId === row.executor_enrollment_id;
    const action = input.action;
    if (
      typeof action !== 'string' ||
      (action === 'execute' && !executionOwner) ||
      (action !== 'execute' && !permitted(role, action))
    )
      return deny();
    if (
      ['execute', 'merge'].includes(action) &&
      (row.status !== 'active' ||
        row.active_revision === null ||
        input.expectedRegistryVersion !== row.registry_version)
    )
      return rpcErrorResponse(undefined, 'conflict', { reason: 'factory-authority-stale' });
    return response({
      role,
      userId: m.userId,
      ownerId: row.owner_id,
      organizationAdmin: m.role === 'owner',
      executor: executionOwner,
      executionOwner,
      revision: row.revision,
      registryVersion: row.registry_version,
      status: row.status,
      activeRevision: row.active_revision,
    });
  }
  if (operation === 'factory.registry.read') {
    const snapshot = recipientSnapshot(row.snapshot_json, m.userId);
    return response({
      id: row.id,
      revision: row.revision,
      registryVersion: row.registry_version,
      definitionDigest: row.definition_digest,
      policy: access,
      source: src,
      role,
      organizationAdmin: m.role === 'owner',
      executionOwner:
        auth.accountId === row.executor_account_id &&
        auth.enrollmentId === row.executor_enrollment_id,
      ownerId: row.owner_id,
      status: row.status,
      activeRevision: row.active_revision,
      activatedAt: row.activated_at,
      snapshot,
      accessPending: !snapshot,
      updatedAt: row.updated_at,
    });
  }
  if (operation === 'factory.snapshot.rewrap') {
    if (
      role !== 'owner' ||
      auth.accountId !== row.executor_account_id ||
      auth.enrollmentId !== row.executor_enrollment_id ||
      input.revision !== row.revision ||
      input.registryVersion !== row.registry_version ||
      input.definitionDigest !== row.definition_digest ||
      !validSnapshot(input.snapshot)
    )
      return deny();
    for (const [userId, wrap] of Object.entries(input.snapshot.keys)) {
      const recipient = await db
        .prepare(
          `SELECT k.public_key,k.github_login,m.role,b.sync_account_id AS account_id FROM hosted_factory_keys k JOIN hosted_organization_memberships m ON m.organization_id=k.organization_id AND m.workos_user_id=k.user_id JOIN billing_accounts b ON b.id=m.billing_account_id AND b.lifecycle='active' WHERE k.organization_id=? AND k.user_id=? AND m.status='active' AND m.workos_sync_status='synced'`,
        )
        .bind(row.organization_id, userId)
        .first<{
          public_key: string;
          github_login: string | null;
          role: string;
          account_id: string | null;
        }>();
      const explicit = access.members.some((x) => x.userId === userId),
        privileged =
          recipient?.role === 'owner' ||
          userId === row.owner_id ||
          recipient?.account_id === row.executor_account_id;
      if (
        recipient?.public_key !== wrap.publicKey ||
        (access.visibility === 'restricted' && !explicit && !privileged)
      )
        return deny();
      const team =
        access.visibility === 'team' && !explicit && !privileged ? access.teamId : undefined;
      if (!(await actorSourceAccess(src, input.githubToken, recipient.github_login, team)))
        return deny();
    }
    const changed = await db
      .prepare(
        'UPDATE hosted_factories SET snapshot_json=? WHERE id=? AND revision=? AND registry_version=?',
      )
      .bind(JSON.stringify(input.snapshot), row.id, row.revision, row.registry_version)
      .run();
    if (!changed.meta.changes) return rpcErrorResponse(undefined, 'conflict');
    return response({ published: true, registryVersion: row.registry_version });
  }
  if (operation === 'factory.snapshot.publish') {
    if (
      role !== 'owner' ||
      input.runId === undefined ||
      auth.accountId !== row.executor_account_id ||
      auth.enrollmentId !== row.executor_enrollment_id ||
      !validSnapshot(input.snapshot)
    )
      return deny();
    if (input.revision !== row.revision) return rpcErrorResponse(undefined, 'conflict');
    // Every wrapped key must still belong to a current member with this key.
    for (const [userId, wrap] of Object.entries(input.snapshot.keys)) {
      const recipient = await db
        .prepare(
          `SELECT k.public_key,k.github_login,m.role,b.sync_account_id AS account_id FROM hosted_factory_keys k JOIN hosted_organization_memberships m ON m.organization_id=k.organization_id AND m.workos_user_id=k.user_id JOIN billing_accounts b ON b.id=m.billing_account_id AND b.lifecycle='active' WHERE k.organization_id=? AND k.user_id=? AND m.status='active' AND m.workos_sync_status='synced'`,
        )
        .bind(row.organization_id, userId)
        .first<{
          public_key: string;
          github_login: string | null;
          role: string;
          account_id: string | null;
        }>();
      const explicit = access.members.some((x) => x.userId === userId),
        privileged =
          recipient?.role === 'owner' ||
          userId === row.owner_id ||
          recipient?.account_id === row.executor_account_id;
      if (
        recipient?.public_key !== wrap.publicKey ||
        (access.visibility === 'restricted' && !explicit && !privileged)
      )
        return deny();
      const team =
        access.visibility === 'team' && !explicit && !privileged ? access.teamId : undefined;
      if (!(await actorSourceAccess(src, input.githubToken, recipient.github_login, team)))
        return deny();
    }
    let written;
    if (
      !id(input.runId) ||
      !Number.isSafeInteger(input.version) ||
      Number(input.version) < 1 ||
      typeof input.payloadDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(input.payloadDigest)
    )
      return malformed();
    const serialized = JSON.stringify(input.snapshot);
    written = await db
      .prepare(
        `INSERT INTO hosted_factory_runs(factory_id,id,version,payload_digest,snapshot_json,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(factory_id,id) DO UPDATE SET version=excluded.version,payload_digest=excluded.payload_digest,snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at WHERE hosted_factory_runs.version<excluded.version OR (hosted_factory_runs.version=excluded.version AND hosted_factory_runs.payload_digest=excluded.payload_digest)`,
      )
      .bind(row.id, input.runId, input.version, input.payloadDigest, serialized, Date.now())
      .run();
    if (!written?.meta.changes) return rpcErrorResponse(undefined, 'conflict');
    return response({ published: true });
  }
  if (operation === 'factory.run.list' || operation === 'factory.run.read') {
    const rows =
      operation === 'factory.run.list'
        ? await db
            .prepare(
              'SELECT id,version,snapshot_json FROM hosted_factory_runs WHERE factory_id=? ORDER BY updated_at DESC LIMIT 100',
            )
            .bind(row.id)
            .all<{ id: string; version: number; snapshot_json: string }>()
        : {
            results: [
              await db
                .prepare(
                  'SELECT id,version,snapshot_json FROM hosted_factory_runs WHERE factory_id=? AND id=?',
                )
                .bind(row.id, String(input.runId))
                .first<{ id: string; version: number; snapshot_json: string }>(),
            ],
          };
    return response({
      runs: (rows.results ?? [])
        .flatMap((x) => (x ? [x] : []))
        .map((x) => ({
          id: x.id,
          version: x.version,
          snapshot: recipientSnapshot(x.snapshot_json, m.userId),
          accessPending: !recipientSnapshot(x.snapshot_json, m.userId),
        })),
    });
  }
  const isExecutor =
    auth.accountId === row.executor_account_id && auth.enrollmentId === row.executor_enrollment_id;
  if (operation === 'factory.issue.claim') {
    if (
      !isExecutor ||
      role !== 'owner' ||
      !Number.isSafeInteger(input.issueNumber) ||
      Number(input.issueNumber) < 1 ||
      !id(input.runId)
    )
      return deny();
    const sourceKey = `${src.host}/${src.owner}/${src.repo}`.toLowerCase();
    await db
      .prepare(
        'INSERT OR IGNORE INTO hosted_factory_issue_claims(organization_id,source,issue_number,factory_id,run_id,created_at) VALUES(?,?,?,?,?,?)',
      )
      .bind(row.organization_id, sourceKey, input.issueNumber, row.id, input.runId, Date.now())
      .run();
    const claim = await db
      .prepare(
        'SELECT factory_id,run_id FROM hosted_factory_issue_claims WHERE organization_id=? AND source=? AND issue_number=?',
      )
      .bind(row.organization_id, sourceKey, input.issueNumber)
      .first<{ factory_id: string; run_id: string }>();
    return response({ claimed: claim?.factory_id === row.id && claim.run_id === input.runId });
  }
  if (operation === 'factory.command.send') {
    const command = input.command;
    if (
      !isRecord(command) ||
      !id(command.id) ||
      !['pause', 'resume', 'deactivate', 'cancel', 'retry', 'approve-merge', 'takeover'].includes(
        String(command.action),
      )
    )
      return malformed();
    if (
      !permitted(
        role,
        command.action === 'approve-merge' || command.action === 'deactivate' ? 'merge' : 'operate',
      )
    )
      return deny();
    if (
      (command.runId !== undefined && !id(command.runId)) ||
      (command.expectedHeadSha !== undefined &&
        (typeof command.expectedHeadSha !== 'string' ||
          !/^[a-f0-9]{40,64}$/.test(command.expectedHeadSha)))
    )
      return malformed();
    if (
      command.runId === undefined &&
      !['pause', 'resume', 'deactivate'].includes(String(command.action))
    )
      return malformed();
    if (
      command.action === 'approve-merge' &&
      (row.status !== 'active' || row.active_revision === null)
    )
      return rpcErrorResponse(undefined, 'conflict', { reason: 'factory-not-active' });
    if (command.runId !== undefined) {
      if (command.action === 'deactivate') return malformed();
      const target = await db
        .prepare('SELECT 1 FROM hosted_factory_runs WHERE factory_id=? AND id=?')
        .bind(row.id, command.runId)
        .first();
      if (!target) return deny();
      if (command.action === 'approve-merge' && !command.expectedHeadSha) return malformed();
    }
    const actorGithubLogin = await githubLogin(input.githubToken);
    if (!actorGithubLogin) return deny();
    const payload = {
      id: command.id,
      factoryId: row.id,
      runId: command.runId,
      action: command.action,
      expectedHeadSha: command.expectedHeadSha,
      expectedRegistryVersion: row.registry_version,
      actorId: m.userId,
      actorGithubLogin,
      createdAt: new Date().toISOString(),
    };
    const existing = await db
      .prepare('SELECT factory_id,actor_id,payload_json FROM hosted_factory_commands WHERE id=?')
      .bind(command.id)
      .first<{ factory_id: string; actor_id: string; payload_json: string }>();
    if (existing) {
      const previous = JSON.parse(existing.payload_json) as Record<string, unknown>;
      if (
        existing.factory_id !== row.id ||
        existing.actor_id !== m.userId ||
        previous.action !== command.action ||
        previous.runId !== command.runId ||
        previous.expectedHeadSha !== command.expectedHeadSha
      )
        return rpcErrorResponse(undefined, 'conflict');
      return response({ accepted: true });
    }
    await db
      .prepare(
        'INSERT INTO hosted_factory_commands(id,factory_id,actor_id,payload_json,created_at) VALUES(?,?,?,?,?)',
      )
      .bind(command.id, row.id, m.userId, JSON.stringify(payload), Date.now())
      .run();
    await audit(db, row.id, m.userId, `command:${command.action}`);
    return response({ accepted: true });
  }
  if (operation === 'factory.command.take') {
    if (role !== 'owner' || !isExecutor) return deny();
    const commands = await db
      .prepare(
        "SELECT id,actor_id,payload_json FROM hosted_factory_commands WHERE factory_id=? AND (state='pending' OR (state='claimed' AND lease_until<?)) ORDER BY created_at LIMIT 20",
      )
      .bind(row.id, Date.now())
      .all<{ id: string; actor_id: string; payload_json: string }>();
    const output: unknown[] = [];
    for (const command of commands.results ?? []) {
      const actor = await db
        .prepare(
          `SELECT b.sync_account_id FROM billing_accounts b JOIN hosted_organization_memberships m ON m.billing_account_id=b.id WHERE b.workos_user_id=? AND m.organization_id=? AND b.lifecycle='active'`,
        )
        .bind(command.actor_id, row.organization_id)
        .first<{ sync_account_id: string }>();
      const current = actor ? await member(db, actor.sync_account_id, row.organization_id) : null,
        currentRole = current ? roleFor(row, current) : null;
      const payload = JSON.parse(command.payload_json) as {
        action: string;
        actorGithubLogin?: string;
        expectedRegistryVersion?: number;
      };
      const team =
        access.visibility === 'team' &&
        current?.role !== 'owner' &&
        row.owner_id !== command.actor_id &&
        !access.members.some((x) => x.userId === command.actor_id)
          ? access.teamId
          : undefined;
      if (
        !currentRole ||
        !permitted(
          currentRole,
          payload.action === 'approve-merge' || payload.action === 'deactivate'
            ? 'merge'
            : 'operate',
        ) ||
        (payload.action === 'approve-merge' &&
          (row.status !== 'active' ||
            row.active_revision === null ||
            payload.expectedRegistryVersion !== row.registry_version)) ||
        !(await actorSourceAccess(src, input.githubToken, payload.actorGithubLogin, team))
      ) {
        await db
          .prepare("UPDATE hosted_factory_commands SET state='revoked',completed_at=? WHERE id=?")
          .bind(Date.now(), command.id)
          .run();
        continue;
      }
      const leaseToken = crypto.randomUUID(),
        now = Date.now();
      const claim = await db
        .prepare(
          "UPDATE hosted_factory_commands SET state='claimed',lease_token=?,lease_until=? WHERE id=? AND (state='pending' OR (state='claimed' AND lease_until<?))",
        )
        .bind(leaseToken, now + 60000, command.id, now)
        .run();
      if (claim.meta.changes)
        output.push({ ...(JSON.parse(command.payload_json) as object), leaseToken });
    }
    return response({ commands: output });
  }
  if (operation === 'factory.command.complete') {
    if (
      role !== 'owner' ||
      !isExecutor ||
      !id(input.commandId) ||
      typeof input.leaseToken !== 'string'
    )
      return deny();
    const changed = await db
      .prepare(
        "UPDATE hosted_factory_commands SET state='completed',completed_at=?,result_json=? WHERE id=? AND factory_id=? AND state='claimed' AND lease_token=? AND lease_until>=?",
      )
      .bind(
        Date.now(),
        JSON.stringify({ ok: input.ok === true }),
        input.commandId,
        row.id,
        input.leaseToken,
        Date.now(),
      )
      .run();
    if (!changed.meta.changes) return rpcErrorResponse(undefined, 'conflict');
    return response({ completed: true });
  }
  return malformed();
}

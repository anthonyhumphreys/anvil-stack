import type { VerifiedAuth } from '../auth';
import { isRecord, rpcErrorResponse } from '../rpc';
import { parseSkillRecommendationSources } from '../../../contract/skill-recommendations';

// Resolve organisation authority from the authenticated session on every operation.
const MEMBERSHIP = `SELECT o.id AS organizationId, o.name, m.role,
  COALESCE(r.version, 0) AS version, COALESCE(r.sources_json, '[]') AS sourcesJson
  FROM billing_accounts b
  JOIN hosted_organization_memberships m ON m.billing_account_id = b.id
  JOIN hosted_organizations o ON o.id = m.organization_id
  LEFT JOIN hosted_skill_recommendations r ON r.organization_id = o.id
  WHERE b.sync_account_id = ? AND b.lifecycle = 'active' AND o.status = 'active'
    AND m.status = 'active' AND m.workos_sync_status = 'synced'
    AND m.workos_client_id = b.workos_client_id AND m.workos_user_id = b.workos_user_id`;

interface OrganizationRow {
  organizationId: string;
  name: string;
  role: string;
  version: number;
  sourcesJson: string;
}

export async function handleSkillRecommendationsOperation(
  operation: string,
  params: unknown,
  auth: VerifiedAuth,
  env: Env,
): Promise<Response> {
  if (operation !== 'skills.recommendations.list' && operation !== 'skills.recommendations.set') {
    return rpcErrorResponse(undefined, 'unsupported-operation');
  }
  if (!env.HOSTED_DB) return rpcErrorResponse(undefined, 'unsupported-operation');
  if (auth.enrollmentClass === 'ephemeral') return rpcErrorResponse(undefined, 'forbidden');
  if (!isRecord(params)) return rpcErrorResponse(undefined, 'malformed-request');
  const db = env.HOSTED_DB;
  if (operation === 'skills.recommendations.list') {
    const { results } = await db
      .prepare(`${MEMBERSHIP} ORDER BY o.name, o.id`)
      .bind(auth.accountId)
      .all<OrganizationRow>();
    return Response.json({
      organizations: results.map((row) => ({
        organizationId: row.organizationId,
        name: row.name,
        canEdit: row.role === 'owner',
        version: row.version,
        sources: parseSkillRecommendationSources(JSON.parse(row.sourcesJson)),
      })),
    });
  }
  if (
    typeof params.organizationId !== 'string' ||
    params.organizationId.length > 200 ||
    !Number.isSafeInteger(params.expectedVersion) ||
    (params.expectedVersion as number) < 0
  )
    return rpcErrorResponse(undefined, 'malformed-request');
  let sources;
  try {
    sources = parseSkillRecommendationSources(params.sources);
  } catch {
    return rpcErrorResponse(undefined, 'malformed-request');
  }

  // Authority and compare-and-swap are part of the write statement, so revocation
  // or another owner's edit between read and write cannot be bypassed.
  const result = await db
    .prepare(
      `
    INSERT INTO hosted_skill_recommendations (organization_id, version, sources_json, updated_at)
    SELECT organizationId, ? + 1, ?, ? FROM (${MEMBERSHIP})
    WHERE organizationId = ? AND role = 'owner' AND version = ?
    ON CONFLICT(organization_id) DO UPDATE SET
      version = excluded.version, sources_json = excluded.sources_json, updated_at = excluded.updated_at
    WHERE hosted_skill_recommendations.version = ?
  `,
    )
    .bind(
      params.expectedVersion,
      JSON.stringify(sources),
      Date.now(),
      auth.accountId,
      params.organizationId,
      params.expectedVersion,
      params.expectedVersion,
    )
    .run();
  if (result.meta.changes === 0) {
    const member = await db
      .prepare(`${MEMBERSHIP} AND o.id = ?`)
      .bind(auth.accountId, params.organizationId)
      .first<OrganizationRow>();
    return rpcErrorResponse(undefined, member?.role === 'owner' ? 'conflict' : 'forbidden');
  }
  return Response.json({ version: (params.expectedVersion as number) + 1 });
}

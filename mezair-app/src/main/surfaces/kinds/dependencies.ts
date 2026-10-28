// Dependencies surface handler (§8.5): deps_list / deps_audit / deps_licenses
// publish or patch one surface per repo (key `deps:<repoId>`); deps_sbom
// produces an SBOM file and tells the agent how to keep it as an artifact.
import { createHash } from 'node:crypto';
import type { MainSurfaceHandler, SurfaceActionContext } from '../types.js';
import type {
  JsonSchema,
  SurfaceActionRequest,
  SurfaceActionResult,
} from '../../../shared/surfaces/types.js';
import type { SbomFormat } from '../../../shared/types.js';
import {
  DEPENDENCY_MANAGERS,
  dependenciesSurfaceKind,
  packageKey,
  worstSeverity,
  type DependenciesSurfaceData,
  type DependencyManager,
  type DependencyPackage,
} from '../../../shared/surfaces/kinds/dependencies.js';
import {
  assertRepoInScope,
  textResult,
  type AgentToolCallResult,
  type AgentToolDefinition,
  type AgentToolSessionContext,
} from '../../agent-tools/dispatch.js';
import { deliverSurfaceFeedback, patchSurface, publishSurface } from '../core.js';
import { upsertChatArtifact } from '../../services/chat-artifact.service.js';
import { publishArtifactSurface } from './artifact.js';
import {
  auditLicenses,
  exportSbom,
  listDependencies,
  runDependencyAudit,
} from '../../services/dependencies.service.js';
import {
  actionError,
  actionOk,
  errorMessage,
  getRepoRecord,
  parseToolArgs,
  renderTemplate,
  requireTargets,
  surfaceToolResult,
  type RepoRecord,
} from './data/tool-kit.js';
import { findKeyedSurface, rememberKeyedSurface } from './data/keyed-surfaces.js';
import {
  NoWorkItemProviderError,
  createWorkItemsForDrafts,
  describeWorkItemBatch,
} from './data/work-items.js';
import { parseAuditOutput } from './dependencies/audit-parse.js';
import { applyAudit, applyLicenses, mergeDependencyList } from './dependencies/merge.js';
import { dependenciesSnapshot } from './dependencies/snapshot.js';

const KIND = 'dependencies';
const SBOM_FORMATS: readonly SbomFormat[] = ['cyclonedx-json', 'spdx-json', 'csv'];

export function dependenciesKey(repoId: string): string {
  return `deps:${repoId}`;
}

const repoInput: JsonSchema = {
  type: 'object',
  required: ['repoId'],
  properties: { repoId: { type: 'string', description: 'Repository id from this session.' } },
  additionalProperties: false,
};

const auditInput: JsonSchema = {
  type: 'object',
  required: ['repoId', 'manager'],
  properties: {
    repoId: { type: 'string', description: 'Repository id from this session.' },
    manager: { type: 'string', enum: DEPENDENCY_MANAGERS },
  },
  additionalProperties: false,
};

const sbomInput: JsonSchema = {
  type: 'object',
  required: ['repoId', 'format'],
  properties: {
    repoId: { type: 'string', description: 'Repository id from this session.' },
    format: { type: 'string', enum: SBOM_FORMATS },
  },
  additionalProperties: false,
};

const TOOLS: AgentToolDefinition[] = [
  {
    name: 'deps_list',
    title: 'List dependencies',
    description:
      'List a repo’s declared dependencies (npm/pnpm/yarn, NuGet, Python) and show them on the Dependencies surface (one per repo; updates in place). Returns a digest and surfaceId.',
    inputSchema: repoInput,
    feature: 'dependencies',
  },
  {
    name: 'deps_audit',
    title: 'Audit dependencies',
    description:
      'Run the package manager’s security audit and overlay advisories on the repo’s Dependencies surface.',
    inputSchema: auditInput,
    feature: 'dependencies',
  },
  {
    name: 'deps_licenses',
    title: 'Check dependency licences',
    description:
      'Read installed package licences and overlay them (allowed / restricted / unknown) on the Dependencies surface.',
    inputSchema: repoInput,
    feature: 'dependencies',
  },
  {
    name: 'deps_sbom',
    title: 'Export SBOM',
    description:
      'Generate an SBOM (cyclonedx-json, spdx-json or csv) and keep it as a session artifact shown inline. Returns a digest and the artifact id, not the SBOM content.',
    inputSchema: sbomInput,
    feature: 'dependencies',
  },
];

// ---------------------------------------------------------------------------
// Surface upsert
// ---------------------------------------------------------------------------

type Transform = (data: DependenciesSurfaceData) => DependenciesSurfaceData;

async function upsertDependencies(
  ctx: AgentToolSessionContext,
  repo: RepoRecord,
  transform: Transform,
  options: { refreshList: boolean; streaming?: boolean },
) {
  const key = dependenciesKey(repo.id);
  const title = `Dependencies · ${repo.name}`;
  const existing = findKeyedSurface(ctx, key);
  const repoRef = { repoId: repo.id, repoName: repo.name };
  if (existing && !options.refreshList) {
    return patchSurface<DependenciesSurfaceData>(existing.id, undefined, transform, {
      streaming: options.streaming ?? false,
    });
  }
  const records = await listDependencies(repo.path);
  if (existing) {
    return patchSurface<DependenciesSurfaceData>(
      existing.id,
      undefined,
      (current) => transform(mergeDependencyList(repoRef, records, current)),
      { streaming: options.streaming ?? false },
    );
  }
  const intent = publishSurface<DependenciesSurfaceData>(ctx, {
    surfaceKind: KIND,
    title,
    key,
    data: transform(mergeDependencyList(repoRef, records, null)),
    streaming: options.streaming ?? false,
  });
  rememberKeyedSurface(ctx, key, intent.id);
  return intent;
}

async function depsListTool(ctx: AgentToolSessionContext, args: Record<string, unknown>) {
  const input = parseToolArgs<{ repoId: string }>(repoInput, args);
  const repo = getRepoRecord(assertRepoInScope(ctx, input.repoId));
  const intent = await upsertDependencies(ctx, repo, (data) => data, { refreshList: true });
  const data = intent.payload.data as DependenciesSurfaceData;
  const hint =
    data.summary.total === 0
      ? 'No supported manifests found (package.json, *.csproj at the root, requirements.txt).'
      : undefined;
  return surfaceToolResult(intent, {}, hint);
}

async function depsAuditTool(ctx: AgentToolSessionContext, args: Record<string, unknown>) {
  const input = parseToolArgs<{ repoId: string; manager: DependencyManager }>(auditInput, args);
  const repo = getRepoRecord(assertRepoInScope(ctx, input.repoId));
  let parsed: ReturnType<typeof parseAuditOutput> | { error: string };
  try {
    const result = await runDependencyAudit(repo.path, input.manager);
    parsed = parseAuditOutput(input.manager, result.stdout);
  } catch (error) {
    parsed = { error: errorMessage(error) };
  }
  const intent = await upsertDependencies(
    ctx,
    repo,
    (data) => applyAudit(data, input.manager, parsed),
    { refreshList: false },
  );
  const note =
    'error' in parsed
      ? `The ${input.manager} audit failed: ${parsed.error.slice(0, 300)}`
      : parsed.note;
  return surfaceToolResult(intent, { manager: input.manager, ok: !('error' in parsed) }, note);
}

async function depsLicensesTool(ctx: AgentToolSessionContext, args: Record<string, unknown>) {
  const input = parseToolArgs<{ repoId: string }>(repoInput, args);
  const repo = getRepoRecord(assertRepoInScope(ctx, input.repoId));
  const result = await auditLicenses(repo.path);
  const intent = await upsertDependencies(ctx, repo, (data) => applyLicenses(data, result), {
    refreshList: false,
  });
  return surfaceToolResult(
    intent,
    {},
    result.unknown > 0
      ? `${result.unknown} packages have no readable licence (licences are read from installed node_modules).`
      : undefined,
  );
}

function sbomComponentCount(format: SbomFormat, content: string): number {
  if (format === 'csv') return Math.max(0, content.split('\n').filter(Boolean).length - 1);
  try {
    const parsed = JSON.parse(content) as { components?: unknown[]; packages?: unknown[] };
    return (format === 'cyclonedx-json' ? parsed.components : parsed.packages)?.length ?? 0;
  } catch {
    return 0;
  }
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'repo'
  );
}

export function sbomArtifactPath(repoName: string, format: SbomFormat, now = new Date()): string {
  const ext = format === 'csv' ? 'csv' : 'json';
  const stamp = now.toISOString().slice(0, 10);
  return `sbom/${slug(repoName)}-${format}-${stamp}.${ext}`;
}

async function depsSbomTool(
  ctx: AgentToolSessionContext,
  args: Record<string, unknown>,
): Promise<AgentToolCallResult> {
  const input = parseToolArgs<{ repoId: string; format: SbomFormat }>(sbomInput, args);
  const repo = getRepoRecord(assertRepoInScope(ctx, input.repoId));
  const content = await exportSbom(repo.path, input.format);
  const components = sbomComponentCount(input.format, content);
  const bytes = Buffer.byteLength(content, 'utf8');
  const sha256 = createHash('sha256').update(content).digest('hex');
  const artifact = upsertChatArtifact({
    threadId: ctx.appThreadId!,
    repoId: null,
    title: `SBOM · ${repo.name} (${input.format})`,
    kind: input.format === 'csv' ? 'csv' : 'data',
    storage: 'session',
    relativePath: sbomArtifactPath(repo.name, input.format),
    content,
    source: 'assistant',
  });
  publishArtifactSurface(ctx, artifact, artifact.version > 1 ? 'updated' : 'created');
  return textResult(
    [
      `SBOM for ${repo.name}: ${input.format}, ${components} components, ${bytes} bytes (sha256 ${sha256.slice(0, 12)}).`,
      `Kept as session artifact ${artifact.id} v${artifact.version}; it is shown inline. Use artifact_update or save_to_repo to change where it lives.`,
    ].join('\n'),
    { artifactId: artifact.id, version: artifact.version, format: input.format, components, bytes, sha256 },
  );
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export function describePackagesForAgent(packages: readonly DependencyPackage[]): string {
  return packages
    .map((pkg) => {
      const parts = [`- ${packageKey(pkg)}@${pkg.version}${pkg.direct ? '' : ' (transitive)'}`];
      const vulnerabilities = pkg.vulnerabilities ?? [];
      if (vulnerabilities.length > 0) {
        parts.push(
          `  advisories: ${vulnerabilities
            .slice(0, 5)
            .map(
              (vulnerability) =>
                `${vulnerability.id} ${vulnerability.severity}${vulnerability.fixedIn ? ` (fixed in ${vulnerability.fixedIn})` : ''}`,
            )
            .join('; ')}${vulnerabilities.length > 5 ? ' …' : ''}`,
        );
      }
      if (pkg.licenseStatus === 'restricted') parts.push(`  licence: ${pkg.license} (restricted)`);
      if (pkg.deprecated) {
        parts.push(`  deprecated${pkg.alternative ? `; consider ${pkg.alternative}` : ''}`);
      }
      return parts.join('\n');
    })
    .join('\n');
}

async function executeDependenciesAction(
  ctx: SurfaceActionContext,
  request: SurfaceActionRequest,
): Promise<SurfaceActionResult> {
  const data = ctx.intent.payload.data as DependenciesSurfaceData;
  if (!(request.action in dependenciesSurfaceKind.actions)) {
    return actionError(`Unknown dependencies action: ${request.action}`);
  }
  const requested = new Set(requireTargets(request.targetIds));
  const targets = data.packages.filter((pkg) => requested.has(packageKey(pkg)));
  if (targets.length === 0) return actionError('Select at least one package.');

  if (request.action === 'ask_upgrade') {
    const semantics = dependenciesSurfaceKind.actions.ask_upgrade.semantics;
    const template = semantics.type === 'agent-message' ? semantics.template : '{targets}';
    const message = [
      renderTemplate(template, {
        repoId: data.repoId,
        targets: describePackagesForAgent(targets),
      }),
      `(Dependencies surface ${ctx.intent.id}.)`,
      request.note ? `User note: ${request.note}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const delivered = await deliverSurfaceFeedback(ctx.intent.id, message);
    return delivered
      ? actionOk(
          `Asked the agent to upgrade ${targets.length} package${targets.length === 1 ? '' : 's'}.`,
        )
      : actionError('No live agent session for this thread. Reopen the thread and try again.');
  }

  const pending = targets.filter((pkg) => !pkg.workItemId);
  if (pending.length === 0) return actionError('The selected packages already have work items.');
  try {
    const batch = await createWorkItemsForDrafts(
      pending.map((pkg) => {
        const worst = worstSeverity(pkg);
        const reason = worst
          ? `${pkg.vulnerabilities?.length} advisories, worst ${worst}`
          : pkg.licenseStatus === 'restricted'
            ? `restricted licence ${pkg.license}`
            : pkg.deprecated
              ? 'deprecated'
              : 'review';
        return {
          targetId: packageKey(pkg),
          title: `Upgrade ${pkg.name} (${pkg.manager}): ${reason}`,
          description: `${data.repoName ?? data.repoId}\n\n${describePackagesForAgent([pkg])}`,
        };
      }),
    );
    const created = new Map(batch.created.map((entry) => [entry.targetId, entry.workItemId]));
    if (created.size > 0) {
      patchSurface<DependenciesSurfaceData>(ctx.intent.id, undefined, (current) => ({
        ...current,
        packages: current.packages.map((pkg) =>
          created.has(packageKey(pkg)) ? { ...pkg, workItemId: created.get(packageKey(pkg)) } : pkg,
        ),
      }));
    }
    const message = describeWorkItemBatch(batch);
    return batch.created.length > 0 ? actionOk(message) : actionError(message);
  } catch (error) {
    if (error instanceof NoWorkItemProviderError) return actionError(error.message);
    return actionError(`Could not create work items: ${errorMessage(error)}`);
  }
}

export const dependenciesSurfaceHandler: MainSurfaceHandler = {
  kind: KIND,
  toolProvider: {
    id: 'surface:dependencies',
    tools: () => TOOLS,
    async call(ctx, name, args) {
      switch (name) {
        case 'deps_list':
          return depsListTool(ctx, args);
        case 'deps_audit':
          return depsAuditTool(ctx, args);
        case 'deps_licenses':
          return depsLicensesTool(ctx, args);
        case 'deps_sbom':
          return depsSbomTool(ctx, args);
        default:
          return undefined;
      }
    },
  },
  executeAction: executeDependenciesAction,
  share: {
    // Package names, versions and licences carry no local paths or secrets.
    redact: (data) => data,
    snapshot: (data, title) => dependenciesSnapshot(data as DependenciesSurfaceData, title),
  },
};

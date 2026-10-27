import {
  Eye,
  GitMerge,
  GitPullRequest,
  Hammer,
  Inbox,
  ListChecks,
  Server,
  ShieldCheck,
  Timer,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { FactoryDefinitionInput, FactoryPreview } from '../../../shared/factories';
import type { WorkflowTemplate } from '../../../shared/types';
import { cx } from '../ui/cx';
import { Disclosure, Mono } from './FactoryPrimitives';

function Row({
  icon: Icon,
  label,
  tone,
  children,
}: {
  icon: LucideIcon;
  label: string;
  tone?: 'warning';
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-1 border-t border-border-subtle py-3 first:border-t-0 sm:grid-cols-[148px_minmax(0,1fr)]">
      <dt className="flex h-6 items-center gap-2 text-xs font-medium text-text-tertiary">
        <Icon
          size={14}
          aria-hidden="true"
          className={tone === 'warning' ? 'text-warning' : undefined}
        />
        {label}
      </dt>
      <dd
        className={cx(
          'min-w-0 text-sm leading-6 text-text-primary',
          tone === 'warning' && 'text-warning',
        )}
      >
        {children}
      </dd>
    </div>
  );
}

function audience(access: FactoryDefinitionInput['access']): ReactNode {
  if (access.kind === 'private') return 'Only you';
  const members = access.members.length
    ? ` Named roles: ${access.members.map((member) => `${member.userId} (${member.role})`).join(', ')}.`
    : '';
  const scope =
    access.visibility === 'organization' ? (
      <>Everyone in {access.organizationId}</>
    ) : access.visibility === 'team' ? (
      <>
        GitHub team <Mono>{access.teamId}</Mono> in {access.organizationId}
      </>
    ) : (
      <>Named members of {access.organizationId} only</>
    );
  return (
    <>
      {scope}.{members} Source repository permissions still apply to details and evidence.
    </>
  );
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The authority a definition grants, in the user's terms. */
export function AuthorityRows({
  definition,
  workflow,
  repinned = false,
  runsOnThisDevice = false,
}: {
  definition: FactoryDefinitionInput;
  workflow: WorkflowTemplate | null;
  repinned?: boolean;
  runsOnThisDevice?: boolean;
}) {
  const auto = definition.merge.mode === 'auto-merge';
  const models = workflow ? [...new Set(workflow.nodes.map((node) => node.model))] : [];
  return (
    <>
      <dl>
        <Row icon={Inbox} label="Watches">
          Open issues labelled <Mono>{definition.github.label}</Mono> in{' '}
          <Mono>
            {definition.github.owner}/{definition.github.repo}
          </Mono>
          , branching from <Mono>{definition.github.baseBranch}</Mono>
        </Row>
        <Row icon={Hammer} label="Builds with">
          {workflow ? (
            <>
              {workflow.name}, {plural(workflow.nodes.length, 'step')} on isolated local Codex
              workers{models.length ? ` (${models.join(', ')})` : ''}.
              {repinned && (
                <span className="block text-xs text-text-tertiary">
                  Re-pinned from the current saved workflow. Runs already in progress keep their
                  graph.
                </span>
              )}
            </>
          ) : (
            'The pinned workflow graph.'
          )}
        </Row>
        <Row icon={ListChecks} label="Must prove">
          <ol className="space-y-1">
            {definition.criteria.map((criterion, index) => (
              <li key={`${criterion}-${index}`} className="flex flex-wrap items-baseline gap-x-2">
                <span>{criterion}</span>
                <Mono className="text-xs text-text-tertiary">{definition.checks[index]}</Mono>
              </li>
            ))}
          </ol>
        </Row>
        <Row icon={GitPullRequest} label="Publishes">
          {definition.publication.enabled
            ? `Pushes verified factory branches and opens ${definition.publication.draft ? 'draft ' : ''}pull requests. Never force-pushes or deletes branches.`
            : 'Nothing. Activation requires publication permission.'}
        </Row>
        <Row icon={GitMerge} label="Merges" tone={auto ? 'warning' : undefined}>
          {auto ? (
            <>
              Automatically, by {definition.merge.method}, once every criterion passes at the
              current head
              {definition.merge.requiredChecks.length ? (
                <>
                  , required checks{' '}
                  {definition.merge.requiredChecks.map((check, index) => (
                    <span key={check}>
                      {index > 0 && ', '}
                      <Mono className="text-warning">{check}</Mono>
                    </span>
                  ))}{' '}
                  pass
                </>
              ) : null}
              {definition.merge.requireApproval ? ' and a person approves the review' : ''}.
            </>
          ) : (
            <>
              Only after an authorised person approves each verified head, by{' '}
              {definition.merge.method}.
            </>
          )}
        </Row>
        <Row icon={ShieldCheck} label="After merge">
          Runs{' '}
          {definition.postMergeChecks.map((check, index) => (
            <span key={`${check}-${index}`}>
              {index > 0 && ', '}
              <Mono>{check}</Mono>
            </span>
          ))}{' '}
          on the merge commit before the run counts as done.
        </Row>
        <Row icon={Timer} label="Limits">
          {plural(definition.limits.maxCommands, 'command')} and{' '}
          {plural(definition.limits.maxRunMinutes, 'minute')} per issue,{' '}
          {plural(definition.limits.repairRounds, 'repair round')},{' '}
          {plural(definition.limits.maxConcurrentRuns, 'issue')} at once.
        </Row>
        <Row icon={Eye} label="Visible to">
          {audience(definition.access)}
        </Row>
        {runsOnThisDevice && (
          <Row icon={Server} label="Runs on">
            This device. Activating installs and starts its background service so issues are
            processed while the app is closed. Keep it awake and online.
          </Row>
        )}
      </dl>
      {auto && (
        <div className="mb-1 flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/[0.06] px-3 py-2.5 text-xs leading-5 text-text-secondary">
          <TriangleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-warning" />
          Branch protections and required human reviews on GitHub stay authoritative. An agent’s own
          review never satisfies a required approval.
        </div>
      )}
    </>
  );
}

/** What a reviewed definition may do, plus the exact policy text and fingerprint. */
export function FactoryAuthority({
  preview,
  workflow,
  mode,
  revision,
  repinned = false,
  localExecutor = true,
  children,
}: {
  preview: FactoryPreview;
  workflow: WorkflowTemplate | null;
  mode: 'save' | 'activate';
  revision: number;
  repinned?: boolean;
  localExecutor?: boolean;
  children: ReactNode;
}) {
  const definition = preview.definition;
  return (
    <section
      aria-label={mode === 'activate' ? 'Factory activation review' : 'Factory definition review'}
      className="rounded-2xl border border-border bg-bg-secondary"
    >
      <header className="flex flex-wrap items-start gap-3 border-b border-border-subtle px-5 py-4">
        <ShieldCheck size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-text-secondary" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-text-primary">
            {mode === 'activate'
              ? `Activate revision ${revision}?`
              : `Review what revision ${revision} may do`}
          </h2>
          <p className="mt-1 max-w-prose text-xs leading-5 text-text-secondary">
            {mode === 'activate'
              ? 'Activation is standing authority. Matching issues are processed under exactly this policy; ticket text, comments and retries cannot widen it.'
              : 'Saving keeps the factory inactive. You review this again before it processes any issue.'}
          </p>
        </div>
      </header>
      <div className="px-5">
        <AuthorityRows
          definition={definition}
          workflow={workflow}
          repinned={repinned}
          runsOnThisDevice={mode === 'activate' && localExecutor}
        />
      </div>
      <div className="px-5">
        <Disclosure title="Exact policy statement">
          <ul className="max-w-prose list-disc space-y-1 pl-4 text-xs leading-5 text-text-secondary">
            {preview.summary.map((line, index) => (
              <li key={`${line}-${index}`}>{line}</li>
            ))}
          </ul>
        </Disclosure>
        <Disclosure title="Exact definition">
          <pre className="max-h-72 overflow-auto rounded-lg bg-bg-primary p-3 font-mono text-xs text-text-secondary">
            {JSON.stringify(definition, null, 2)}
          </pre>
        </Disclosure>
      </div>
      <footer className="flex flex-wrap items-center gap-3 border-t border-border-subtle px-5 py-4">
        <p className="mr-auto text-xs text-text-tertiary">
          Review fingerprint <Mono>{preview.confirmation.slice(0, 12)}</Mono>
        </p>
        {children}
      </footer>
    </section>
  );
}

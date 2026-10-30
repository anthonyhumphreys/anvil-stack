import {
  ArrowRight,
  CopyPlus,
  EyeOff,
  Link2,
  PackageOpen,
  RefreshCw,
  Workflow,
} from 'lucide-react';
import { factoryWorkflowDrift, type FactoryDefinition } from '../../../shared/factories';
import type { WorkflowTemplate } from '../../../shared/types';
import { Button } from '../ui/Button';
import { AuthorityRows } from './FactoryAuthority';
import { Mono, Notice, TextAction } from './FactoryPrimitives';
import { absoluteTime, relativeTime } from './factory-line';
import { canReadFactorySource } from './factory-ui-policy';

export function PinnedGraph({ workflow }: { workflow: WorkflowTemplate }) {
  return (
    <ol
      className="flex flex-wrap items-stretch gap-x-1.5 gap-y-2"
      aria-label={`${workflow.name} steps`}
    >
      {workflow.nodes.map((node, index) => (
        <li key={node.id} className="flex items-center gap-1.5">
          {index > 0 && <ArrowRight size={13} aria-hidden="true" className="text-text-muted" />}
          <span
            className="rounded-xl border border-border-subtle px-3 py-2"
            title={node.kind === 'human' ? undefined : `${node.reasoningEffort} reasoning effort`}
          >
            <span className="block text-sm font-medium text-text-primary">{node.name}</span>
            <span className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-text-tertiary">
              <span className="capitalize">
                {node.kind === 'human' ? 'Human step' : node.personaId}
              </span>
              {node.kind !== 'human' && <Mono className="text-text-tertiary">{node.model}</Mono>}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function FactoryDefinitionPanel({
  factory,
  templates,
  canManage,
  now,
  savingCopy,
  onEdit,
  onRepin,
  onOpenTemplate,
  onSaveCopy,
  onLinkTemplate,
}: {
  factory: FactoryDefinition;
  templates: WorkflowTemplate[];
  canManage: boolean;
  now: number;
  savingCopy: boolean;
  onEdit: () => void;
  onRepin: () => void;
  onOpenTemplate: (templateId: string) => void;
  onSaveCopy: () => void;
  onLinkTemplate: (templateId: string) => void;
}) {
  if (!canReadFactorySource(factory))
    return (
      <div className="px-6 py-6">
        <Notice tone="neutral" icon={EyeOff}>
          Source details for this factory are hidden because your account cannot read its
          repository.
        </Notice>
      </div>
    );
  // A shared factory's template id refers to the executing device's library, not this one.
  const template = factory.remote
    ? undefined
    : templates.find((item) => item.id === factory.definition.workflowTemplateId);
  const drift = factory.remote ? null : factoryWorkflowDrift(factory.workflow, template);
  const canRepin = canManage && !factory.remote;
  // A restored or recreated workflow with the same behaviour can take over as the source.
  const match =
    drift === 'missing'
      ? templates.find((item) => factoryWorkflowDrift(factory.workflow, item) === 'current')
      : undefined;
  const revisionLine =
    factory.status === 'draft'
      ? `Revision ${factory.revision}, never activated.`
      : factory.activeRevision && factory.activeRevision !== factory.revision
        ? `Revision ${factory.revision} saved. Revision ${factory.activeRevision} is the one processing issues.`
        : `Revision ${factory.revision}${factory.activatedAt ? `, activated ${relativeTime(factory.activatedAt, now)}` : ''}.`;
  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 px-6 py-6">
      <div className="flex flex-wrap items-center gap-3">
        <p className="mr-auto text-sm text-text-secondary" title={absoluteTime(factory.updatedAt)}>
          {revisionLine}
        </p>
        {canManage && (
          <Button variant="secondary" size="sm" onClick={onEdit}>
            Edit definition
          </Button>
        )}
      </div>

      <section aria-labelledby="pinned-graph-title" className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 id="pinned-graph-title" className="text-sm font-semibold text-text-primary">
            Pinned graph
          </h3>
          <span className="text-xs text-text-tertiary">
            {factory.workflow.name}, copied into this revision. Running work never changes under it.
          </span>
        </div>
        {factory.remote && (
          <p className="text-xs text-text-tertiary">
            This graph was pinned on the executing device. Save a copy to reuse it in your own
            workflows.
          </p>
        )}
        {drift === 'changed' && (
          <Notice
            tone="info"
            icon={RefreshCw}
            action={
              canRepin ? (
                <Button size="sm" variant="secondary" onClick={onRepin}>
                  Review and re-pin
                </Button>
              ) : undefined
            }
          >
            <span className="font-medium text-text-primary">{template?.name}</span> changed after
            this revision pinned it.{' '}
            {canRepin
              ? 'Re-pin it in a new revision to use the changes for future issues.'
              : 'Only an owner on the executing device can re-pin it.'}
          </Notice>
        )}
        {drift === 'missing' && match && (
          <Notice
            tone="info"
            icon={Link2}
            action={
              canRepin ? (
                <Button size="sm" variant="secondary" onClick={() => onLinkTemplate(match.id)}>
                  Link in a new revision
                </Button>
              ) : undefined
            }
          >
            <span className="font-medium text-text-primary">{match.name}</span> matches this pinned
            graph. Link it so future edits to that workflow can be reviewed and re-pinned here.
          </Notice>
        )}
        {drift === 'missing' && !match && (
          <Notice
            tone="warning"
            icon={PackageOpen}
            action={
              <Button size="sm" variant="secondary" disabled={savingCopy} onClick={onSaveCopy}>
                {savingCopy ? 'Restoring…' : 'Restore as workflow'}
              </Button>
            }
          >
            The saved workflow this graph came from was deleted. The factory keeps running its
            pinned copy; restore it to edit or reuse it.
          </Notice>
        )}
        <PinnedGraph workflow={factory.workflow} />
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {template && (
            <TextAction icon={Workflow} onClick={() => onOpenTemplate(template.id)}>
              Open {template.name} in Workflows
            </TextAction>
          )}
          {drift !== 'missing' && (
            <TextAction icon={CopyPlus} disabled={savingCopy} onClick={onSaveCopy}>
              {savingCopy ? 'Saving…' : 'Save pinned graph as a new workflow'}
            </TextAction>
          )}
        </div>
      </section>

      <section aria-labelledby="authority-title" className="space-y-2">
        <h3 id="authority-title" className="text-sm font-semibold text-text-primary">
          What this revision may do
        </h3>
        <div className="rounded-2xl border border-border-subtle px-5">
          <AuthorityRows definition={factory.definition} workflow={factory.workflow} />
        </div>
        <p className="text-xs text-text-tertiary">
          Review fingerprint <Mono>{factory.confirmation.slice(0, 12)}</Mono>
        </p>
      </section>
    </div>
  );
}

import { useMemo } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  CircleStop,
  FileDiff,
  Info,
  Terminal,
  UserRound,
} from 'lucide-react';
import type { RepoInfo } from '../../../shared/types';
import type { ChatRunSummary } from './chat-run-outcome';
import { repoRelativePath, resolveChangesRepoId } from './chat-turn-changes';

const STATE_ICON = {
  completed: CheckCircle2,
  failed: AlertTriangle,
  stopped: CircleStop,
  'awaiting-user': UserRound,
  running: CircleDashed,
  'response-ended': Info,
} as const;

const STATE_CLASS = {
  completed: 'text-success',
  failed: 'text-error',
  stopped: 'text-warning',
  'awaiting-user': 'text-warning',
  running: 'text-info',
  'response-ended': 'text-text-tertiary',
} as const;

/** A compact run result that separates provider evidence from the agent reply above. */
export function ChatRunOutcomeFooter({
  summary,
  repos,
  preferredRepoId,
  onReviewFile,
}: {
  summary: ChatRunSummary;
  repos: RepoInfo[];
  preferredRepoId?: string | null;
  onReviewFile?: (filePath: string) => void;
}) {
  const Icon = STATE_ICON[summary.state];
  const changePaths = useMemo(() => {
    if (!summary.changes) return [];
    const repoId = resolveChangesRepoId(
      summary.changes.files.map((file) => file.filePath),
      repos,
      preferredRepoId,
    );
    const repoPath = repos.find((repo) => repo.id === repoId)?.path;
    return summary.changes.files.map((file) => ({
      ...file,
      displayPath: repoPath
        ? (repoRelativePath(file.filePath, repoPath) ?? file.filePath)
        : file.filePath,
    }));
  }, [preferredRepoId, repos, summary.changes]);

  return (
    <section
      data-testid="chat-run-outcome-footer"
      className="message-bubble flex justify-start"
      aria-label="Run outcome"
    >
      <div className="w-full border-y border-border-subtle/80 py-3">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3">
          <Icon
            size={14}
            className={`mt-0.5 shrink-0 ${STATE_CLASS[summary.state]}`}
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-text-primary">{summary.title}</p>
            <p className="mt-1 text-xs leading-5 text-text-secondary">{summary.nextAction}</p>
          </div>
        </div>

        {summary.changes && changePaths.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 px-3 text-xs">
            <FileDiff size={12} className="shrink-0 text-info" aria-hidden="true" />
            <span className="text-text-tertiary">
              {summary.changes.files.length} file{summary.changes.files.length === 1 ? '' : 's'}{' '}
              changed
              {' · '}+{summary.changes.additions} −{summary.changes.deletions}
            </span>
            {changePaths.slice(0, 4).map((file) => (
              <button
                key={file.filePath}
                type="button"
                onClick={() => onReviewFile?.(file.filePath)}
                disabled={!onReviewFile}
                className="max-w-full truncate font-mono text-info underline decoration-info/30 underline-offset-2 hover:decoration-info disabled:cursor-default disabled:no-underline"
                title={`Review diff for ${file.filePath}`}
              >
                {file.displayPath}
              </button>
            ))}
            {changePaths.length > 4 && (
              <span className="text-text-tertiary">and {changePaths.length - 4} more</span>
            )}
          </div>
        )}

        {summary.commands.length > 0 && (
          <details className="mt-2 px-3">
            <summary className="flex w-fit cursor-pointer items-center gap-1.5 text-xs text-text-tertiary hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
              <Terminal size={12} aria-hidden="true" />
              Observed commands ({summary.commands.length})
            </summary>
            <ul className="mt-2 space-y-2 border-l border-border-subtle pl-3">
              {summary.commands.map((command, index) => (
                <li key={`${command.command}-${index}`} className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <code className="min-w-0 max-w-full break-all font-mono text-xs text-text-secondary">
                      {command.command}
                    </code>
                    <span
                      className={`shrink-0 text-xs ${
                        command.exitCode === 0
                          ? 'text-success'
                          : typeof command.exitCode === 'number'
                            ? 'text-error'
                            : 'text-text-tertiary'
                      }`}
                    >
                      {typeof command.exitCode === 'number'
                        ? `exit ${command.exitCode}`
                        : 'no exit code reported'}
                    </span>
                  </div>
                  {command.output && (
                    <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-md bg-bg-secondary/55 px-2 py-1.5 font-mono text-xs leading-4 text-text-tertiary">
                      {command.output}
                    </pre>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  );
}

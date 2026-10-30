import type {
  CompanionApprovalPolicy,
  CompanionApprovalRisk,
  CompanionSurface,
  MobileApprovalRequest,
} from './types';

const DESTRUCTIVE_TERMS = [
  ' rm ',
  'rm -',
  'rmdir',
  'delete',
  'drop database',
  'drop table',
  'truncate',
  'destroy',
  'terraform apply',
  'pulumi up',
  'kubectl delete',
  'helm uninstall',
  'git reset --hard',
  'git clean',
  'git push --force',
  'npm publish',
  'pnpm publish',
  'yarn publish',
];

const HIGH_RISK_TERMS = [
  'deploy',
  'production',
  'prod',
  'secret',
  'token',
  'password',
  'iam',
  'permission',
  'migration',
  'migrate',
  'chmod',
  'chown',
  'sudo',
  'brew install',
  'npm install',
  'pnpm install',
  'yarn add',
  'pip install',
  'cargo install',
];

const LOW_RISK_COMMAND_PATTERNS = [
  /^git status\b/,
  /^pnpm (test|lint|typecheck|build)\b/,
  /^npm (test|run test|run lint|run typecheck|run build)\b/,
  /^yarn (test|lint|typecheck|build)\b/,
  /^npx (vitest|jest|tsc|eslint)\b/,
  /^vitest\b/,
  /^jest\b/,
  /^tsc\b/,
  /^eslint\b/,
  /^go test\b/,
  /^cargo test\b/,
  /^swift test\b/,
];

export type CarPlayApprovalAction =
  | 'approve'
  | 'decline'
  | 'pause'
  | 'mark-for-later'
  | 'prepare-handover';

export function buildApprovalPolicy(request: MobileApprovalRequest): CompanionApprovalPolicy {
  const requestedAction = describeRequestedAction(request);
  const risk = classifyApprovalRisk(request);
  const requiresFullReview = request.kind !== 'command' || risk !== 'low';
  const allowedSurfaces: CompanionSurface[] =
    risk === 'low' && !requiresFullReview
      ? ['desktop', 'mobile', 'carplay', 'siri']
      : ['desktop', 'mobile'];

  return {
    risk,
    requiresFullReview,
    allowedSurfaces,
    requestedAction,
    summary: summarizeApproval(request, risk),
    blockedReason: risk === 'low' && !requiresFullReview ? undefined : 'Requires desktop review',
  };
}

export function isCarPlayApprovable(
  request: Pick<CompanionApprovalPolicy, 'allowedSurfaces' | 'risk' | 'requiresFullReview'>,
): boolean {
  return (
    request.allowedSurfaces.includes('carplay') &&
    request.risk === 'low' &&
    !request.requiresFullReview
  );
}

export function isCarPlayActionAllowed(
  request: Pick<CompanionApprovalPolicy, 'allowedSurfaces' | 'risk' | 'requiresFullReview'>,
  action: CarPlayApprovalAction,
): boolean {
  if (action === 'approve') return isCarPlayApprovable(request);
  return action === 'decline' || action === 'pause' || action === 'mark-for-later';
}

export function classifyApprovalRisk(request: MobileApprovalRequest): CompanionApprovalRisk {
  if (request.kind !== 'command') return 'medium';

  const command = normalizeCommand(request.command);
  if (!command) return 'high';
  const padded = ` ${command} `;

  if (DESTRUCTIVE_TERMS.some((term) => padded.includes(term))) return 'destructive';
  if (HIGH_RISK_TERMS.some((term) => padded.includes(term))) return 'high';
  if (LOW_RISK_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) return 'low';
  return 'high';
}

function normalizeCommand(command: string | undefined): string {
  return command?.trim().replace(/\s+/g, ' ').toLowerCase() ?? '';
}

function describeRequestedAction(request: MobileApprovalRequest): string {
  if (request.kind === 'file_change') return request.grantRoot ?? 'File change';
  return request.command?.trim() || 'Command approval';
}

function summarizeApproval(request: MobileApprovalRequest, risk: CompanionApprovalRisk): string {
  if (request.kind === 'file_change') {
    return 'File changes need review on the desktop before approval.';
  }
  if (risk === 'low') {
    return 'Low-risk check requested by an active agent.';
  }
  if (risk === 'destructive') {
    return 'Destructive or irreversible command requested.';
  }
  return 'Command needs full desktop context before approval.';
}

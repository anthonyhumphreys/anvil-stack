// Frozen v1 RPC operation inventory (integration-contract section 6).
//
// `sync/1` covers discovery-adjacent session/account/device handling plus
// sync and data portability. `mesh/1` requires `sync/1` plus execution,
// observation, handoff, and artifacts. Actor roles enforce that a user
// controller cannot report another worker's state and a worker cannot
// self-authorize approvals.

export const OPERATIONS = [
  // Session/account
  'session.describe',
  'session.attest',
  'account.delete',
  'account.deletionStatus',
  // Devices
  'device.list',
  'device.rename',
  'device.revoke',
  'device.policy.publish',
  'device.advertise',
  'device.presence',
  // Sync
  'sync.push',
  'sync.pull',
  'sync.scan.begin',
  'sync.scan.page',
  'sync.scan.finish',
  // Data portability
  'data.export.begin',
  'data.export.page',
  'data.import.preview',
  'data.import.commit',
  'data.operationStatus',
  // Worker
  'worker.connect',
  'worker.describe',
  'worker.capabilities.publish',
  'worker.replica.publish',
  // Jobs
  'job.create',
  'job.get',
  'job.list',
  'job.claim',
  'attempt.renew',
  'attempt.report',
  'job.cancel',
  // Events/control
  'event.pull',
  'approval.get',
  'approval.decide',
  // Handoff
  'handoff.create',
  'handoff.get',
  'handoff.advance',
  'handoff.cancel',
  // Artifacts
  'artifact.reserve',
  'artifact.finalize',
  'artifact.get',
  'artifact.list',
  'artifact.delete',
  // ENV-01 cloud environment lifecycle + ENV-06 credential grants
  'environment.report',
  'environment.get',
  'environment.list',
  'environment.reap',
  'environment.bootstrap',
  'credential.deliver',
  'credential.pull',
  // Hosted sharing (user-published artifacts behind revocable share ids)
  'share.create',
  'share.finalize',
  'share.list',
  'share.revoke',
] as const;

export type OperationName = (typeof OPERATIONS)[number];

export type OperationProfile = 'sync/1' | 'mesh/1';

export type ActorRole = 'user' | 'worker' | 'either';

export const OPERATION_PROFILE: Record<OperationName, OperationProfile> = {
  'session.describe': 'sync/1',
  'session.attest': 'sync/1',
  'account.delete': 'sync/1',
  'account.deletionStatus': 'sync/1',
  'device.list': 'sync/1',
  'device.rename': 'sync/1',
  'device.revoke': 'sync/1',
  'device.policy.publish': 'sync/1',
  'device.advertise': 'sync/1',
  'device.presence': 'sync/1',
  'sync.push': 'sync/1',
  'sync.pull': 'sync/1',
  'sync.scan.begin': 'sync/1',
  'sync.scan.page': 'sync/1',
  'sync.scan.finish': 'sync/1',
  'data.export.begin': 'sync/1',
  'data.export.page': 'sync/1',
  'data.import.preview': 'sync/1',
  'data.import.commit': 'sync/1',
  'data.operationStatus': 'sync/1',
  'worker.connect': 'mesh/1',
  'worker.describe': 'mesh/1',
  'worker.capabilities.publish': 'mesh/1',
  'worker.replica.publish': 'mesh/1',
  'job.create': 'mesh/1',
  'job.get': 'mesh/1',
  'job.list': 'mesh/1',
  'job.claim': 'mesh/1',
  'attempt.renew': 'mesh/1',
  'attempt.report': 'mesh/1',
  'job.cancel': 'mesh/1',
  'event.pull': 'mesh/1',
  'approval.get': 'mesh/1',
  'approval.decide': 'mesh/1',
  'handoff.create': 'mesh/1',
  'handoff.get': 'mesh/1',
  'handoff.advance': 'mesh/1',
  'handoff.cancel': 'mesh/1',
  'artifact.reserve': 'mesh/1',
  'artifact.finalize': 'mesh/1',
  'artifact.get': 'mesh/1',
  'artifact.list': 'mesh/1',
  'artifact.delete': 'mesh/1',
  'environment.report': 'mesh/1',
  'environment.get': 'mesh/1',
  'environment.list': 'mesh/1',
  'environment.reap': 'mesh/1',
  'environment.bootstrap': 'mesh/1',
  'credential.deliver': 'mesh/1',
  'credential.pull': 'mesh/1',
  'share.create': 'sync/1',
  'share.finalize': 'sync/1',
  'share.list': 'sync/1',
  'share.revoke': 'sync/1',
};

/**
 * Which actor may invoke each operation. `user` is the initiating
 * controller, `worker` is the executing device reporting its own state,
 * `either` is safe for both (typically reads or generation-fenced writes).
 */
export const OPERATION_ROLE: Record<OperationName, ActorRole> = {
  'session.describe': 'either',
  'session.attest': 'either',
  'account.delete': 'user',
  'account.deletionStatus': 'user',
  'device.list': 'user',
  'device.rename': 'user',
  'device.revoke': 'user',
  'device.policy.publish': 'worker',
  'device.advertise': 'either',
  'device.presence': 'either',
  'sync.push': 'either',
  'sync.pull': 'either',
  'sync.scan.begin': 'either',
  'sync.scan.page': 'either',
  'sync.scan.finish': 'either',
  'data.export.begin': 'user',
  'data.export.page': 'user',
  'data.import.preview': 'user',
  'data.import.commit': 'user',
  'data.operationStatus': 'user',
  'worker.connect': 'worker',
  'worker.describe': 'worker',
  'worker.capabilities.publish': 'worker',
  'worker.replica.publish': 'worker',
  'job.create': 'user',
  'job.get': 'either',
  'job.list': 'either',
  'job.claim': 'worker',
  'attempt.renew': 'worker',
  'attempt.report': 'worker',
  'job.cancel': 'either',
  'event.pull': 'either',
  'approval.get': 'either',
  'approval.decide': 'user',
  'handoff.create': 'user',
  'handoff.get': 'either',
  'handoff.advance': 'either',
  'handoff.cancel': 'either',
  'artifact.reserve': 'worker',
  'artifact.finalize': 'worker',
  'artifact.get': 'either',
  'artifact.list': 'either',
  'artifact.delete': 'user',
  'environment.report': 'worker',
  'environment.get': 'either',
  'environment.list': 'either',
  'environment.reap': 'either',
  'environment.bootstrap': 'user',
  'credential.deliver': 'user',
  'credential.pull': 'worker',
  'share.create': 'user',
  'share.finalize': 'user',
  'share.list': 'user',
  'share.revoke': 'user',
};

export function profileForOperation(operation: OperationName): OperationProfile {
  return OPERATION_PROFILE[operation];
}

export function requiredActorRole(operation: OperationName): ActorRole {
  return OPERATION_ROLE[operation];
}

/**
 * ENV-01: the operation allowlist for `ephemeral` (cloud environment)
 * enrollments. An environment is a job *executor*, never a job *source* or
 * trust administrator: it may sync (to receive keyring wraps and sealed
 * artifacts), publish its policy/capabilities, claim and report attempts,
 * observe its own jobs, manage its own environment record, and pull the
 * credential grants addressed to it. Everything else — creating jobs,
 * minting codes, deciding approvals, managing devices, account ops,
 * sharing — is denied at both the Worker route and the account object.
 */
export const EPHEMERAL_ALLOWED_OPERATIONS: ReadonlySet<OperationName> = new Set([
  'session.describe',
  'device.policy.publish',
  'sync.push',
  'sync.pull',
  'sync.scan.begin',
  'sync.scan.page',
  'sync.scan.finish',
  'worker.connect',
  'worker.describe',
  'worker.capabilities.publish',
  'worker.replica.publish',
  'job.get',
  'job.list',
  'job.claim',
  'attempt.renew',
  'attempt.report',
  'event.pull',
  'approval.get',
  'handoff.get',
  'handoff.advance',
  'handoff.cancel',
  'artifact.reserve',
  'artifact.finalize',
  'artifact.get',
  'artifact.list',
  'environment.report',
  'environment.get',
  'environment.list',
  'environment.reap',
  'credential.pull',
]);

export function ephemeralOperationAllowed(operation: OperationName): boolean {
  return EPHEMERAL_ALLOWED_OPERATIONS.has(operation);
}

/**
 * BILL-03 hosted access classes. `mutating` operations create or extend
 * billable work/data and are denied with 403 when the hosted entitlement
 * is restricted; `control` operations (reads, cancellation, completion
 * reporting, deletion) stay available so users can observe, stop, or
 * finish already-running work and export/delete their data.
 *
 * `attempt.report` and `artifact.finalize` stay `control` deliberately: a
 * restricted account cannot create new attempts or reservations, so any
 * attempt or reservation they complete predates the restriction and is
 * bounded by its existing fences, leases, and quota. The same holds for
 * `job.cancel`, `handoff.cancel`, `approval.decide`, `artifact.delete`,
 * and `account.delete` — stopping, deciding, and deleting must never
 * require payment.
 */
export type HostedOperationClass = 'mutating' | 'control';

export const HOSTED_OPERATION_CLASS: Record<OperationName, HostedOperationClass> = {
  'session.describe': 'control',
  'session.attest': 'control',
  'account.delete': 'control',
  'account.deletionStatus': 'control',
  'device.list': 'control',
  'device.rename': 'control',
  'device.revoke': 'control',
  'device.policy.publish': 'mutating',
  'device.advertise': 'mutating',
  'device.presence': 'control',
  'sync.push': 'mutating',
  'sync.pull': 'control',
  'sync.scan.begin': 'mutating',
  'sync.scan.page': 'control',
  'sync.scan.finish': 'control',
  'data.export.begin': 'control',
  'data.export.page': 'control',
  'data.import.preview': 'mutating',
  'data.import.commit': 'mutating',
  'data.operationStatus': 'control',
  'worker.connect': 'mutating',
  'worker.capabilities.publish': 'mutating',
  'worker.replica.publish': 'mutating',
  'worker.describe': 'control',
  'job.create': 'mutating',
  'job.get': 'control',
  'job.list': 'control',
  'job.claim': 'mutating',
  'attempt.renew': 'mutating',
  'attempt.report': 'control',
  'job.cancel': 'control',
  'event.pull': 'control',
  'approval.get': 'control',
  'approval.decide': 'control',
  'handoff.create': 'mutating',
  'handoff.get': 'control',
  'handoff.advance': 'mutating',
  'handoff.cancel': 'control',
  'artifact.reserve': 'mutating',
  'artifact.finalize': 'control',
  'artifact.get': 'control',
  'artifact.list': 'control',
  'artifact.delete': 'control',
  // environment.* rides on already-created provision jobs: reporting and
  // reaping finish bounded in-flight work, so they stay `control` like
  // attempt.report/job.cancel — stopping must never require payment.
  'environment.report': 'control',
  'environment.get': 'control',
  'environment.list': 'control',
  'environment.reap': 'control',
  // Staging a bootstrap payload extends a provision the user is already
  // authorized to request — gated like job.create so a restricted account
  // cannot mint managed capacity through the back door.
  'environment.bootstrap': 'mutating',
  // Grants are scoped to a claimed attempt's existing fence — delivery and
  // pull finish work that mutating job.claim already authorized.
  'credential.deliver': 'control',
  'credential.pull': 'control',
  'share.create': 'mutating',
  'share.finalize': 'control',
  'share.list': 'control',
  'share.revoke': 'control',
};

// v2 RPC operation inventory (integration-contract section 6).
//
// `sync/2` covers discovery-adjacent session/account/device handling plus
// compact sync and data portability. `mesh/2` requires `sync/2` plus execution,
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
  'sync.snapshot.begin',
  'sync.snapshot.chunk.put',
  'sync.snapshot.verify',
  'sync.snapshot.commit',
  'sync.snapshot.get',
  'sync.snapshot.chunk.get',
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
  'event.append',
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
  'environment.limits',
  'environment.reap',
  'environment.bootstrap',
  'environment.suspend',
  'environment.resume',
  'credential.deliver',
  'credential.pull',
  // Task-scoped keys + rotation reporting
  'taskkey.deliver',
  'taskkey.pull',
  'keyring.report',
  // Dashboard authorization (browser E2EE projection)
  'dashboard.requests',
  'dashboard.decide',
  'dashboard.publish',
  'dashboard.revoke',
  // Hosted sharing (user-published artifacts behind revocable share ids)
  'share.create',
  'share.finalize',
  'share.list',
  'share.revoke',
] as const;

export type OperationName = (typeof OPERATIONS)[number];

export type OperationProfile = 'sync/2' | 'mesh/2';

export type ActorRole = 'user' | 'worker' | 'either';

export const OPERATION_PROFILE: Record<OperationName, OperationProfile> = {
  'session.describe': 'sync/2',
  'session.attest': 'sync/2',
  'account.delete': 'sync/2',
  'account.deletionStatus': 'sync/2',
  'device.list': 'sync/2',
  'device.rename': 'sync/2',
  'device.revoke': 'sync/2',
  'device.policy.publish': 'sync/2',
  'device.advertise': 'sync/2',
  'device.presence': 'sync/2',
  'sync.push': 'sync/2',
  'sync.pull': 'sync/2',
  'sync.scan.begin': 'sync/2',
  'sync.scan.page': 'sync/2',
  'sync.scan.finish': 'sync/2',
  'sync.snapshot.begin': 'sync/2',
  'sync.snapshot.chunk.put': 'sync/2',
  'sync.snapshot.verify': 'sync/2',
  'sync.snapshot.commit': 'sync/2',
  'sync.snapshot.get': 'sync/2',
  'sync.snapshot.chunk.get': 'sync/2',
  'data.export.begin': 'sync/2',
  'data.export.page': 'sync/2',
  'data.import.preview': 'sync/2',
  'data.import.commit': 'sync/2',
  'data.operationStatus': 'sync/2',
  'worker.connect': 'mesh/2',
  'worker.describe': 'mesh/2',
  'worker.capabilities.publish': 'mesh/2',
  'worker.replica.publish': 'mesh/2',
  'job.create': 'mesh/2',
  'job.get': 'mesh/2',
  'job.list': 'mesh/2',
  'job.claim': 'mesh/2',
  'attempt.renew': 'mesh/2',
  'attempt.report': 'mesh/2',
  'job.cancel': 'mesh/2',
  'event.append': 'mesh/2',
  'event.pull': 'mesh/2',
  'approval.get': 'mesh/2',
  'approval.decide': 'mesh/2',
  'handoff.create': 'mesh/2',
  'handoff.get': 'mesh/2',
  'handoff.advance': 'mesh/2',
  'handoff.cancel': 'mesh/2',
  'artifact.reserve': 'mesh/2',
  'artifact.finalize': 'mesh/2',
  'artifact.get': 'mesh/2',
  'artifact.list': 'mesh/2',
  'artifact.delete': 'mesh/2',
  'environment.report': 'mesh/2',
  'environment.get': 'mesh/2',
  'environment.list': 'mesh/2',
  'environment.limits': 'mesh/2',
  'environment.reap': 'mesh/2',
  'environment.bootstrap': 'mesh/2',
  'environment.suspend': 'mesh/2',
  'environment.resume': 'mesh/2',
  'credential.deliver': 'mesh/2',
  'credential.pull': 'mesh/2',
  'taskkey.deliver': 'mesh/2',
  'taskkey.pull': 'mesh/2',
  'keyring.report': 'mesh/2',
  'dashboard.requests': 'mesh/2',
  'dashboard.decide': 'mesh/2',
  'dashboard.publish': 'mesh/2',
  'dashboard.revoke': 'mesh/2',
  'share.create': 'sync/2',
  'share.finalize': 'sync/2',
  'share.list': 'sync/2',
  'share.revoke': 'sync/2',
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
  'sync.snapshot.begin': 'user',
  'sync.snapshot.chunk.put': 'user',
  'sync.snapshot.verify': 'user',
  'sync.snapshot.commit': 'user',
  'sync.snapshot.get': 'either',
  'sync.snapshot.chunk.get': 'either',
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
  'event.append': 'worker',
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
  'environment.limits': 'user',
  'environment.reap': 'either',
  'environment.bootstrap': 'user',
  'environment.suspend': 'user',
  'environment.resume': 'user',
  'credential.deliver': 'user',
  'credential.pull': 'worker',
  'taskkey.deliver': 'user',
  'taskkey.pull': 'either',
  'keyring.report': 'user',
  'dashboard.requests': 'user',
  'dashboard.decide': 'user',
  'dashboard.publish': 'user',
  'dashboard.revoke': 'user',
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
  'sync.snapshot.get',
  'sync.snapshot.chunk.get',
  'worker.connect',
  'worker.describe',
  'worker.capabilities.publish',
  'worker.replica.publish',
  'job.get',
  'job.list',
  'job.claim',
  'attempt.renew',
  'attempt.report',
  'event.append',
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
  'taskkey.pull',
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
  'sync.snapshot.begin': 'mutating',
  // A bounded reservation is allowed to finish during restriction, like
  // artifact.finalize; new storage is gated at begin.
  'sync.snapshot.chunk.put': 'control',
  'sync.snapshot.verify': 'control',
  'sync.snapshot.commit': 'control',
  'sync.snapshot.get': 'control',
  'sync.snapshot.chunk.get': 'control',
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
  'event.append': 'control',
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
  'environment.limits': 'control',
  'environment.reap': 'control',
  // Staging a bootstrap payload extends a provision the user is already
  // authorized to request — gated like job.create so a restricted account
  // cannot mint managed capacity through the back door.
  'environment.bootstrap': 'mutating',
  // Suspend and resume change compute capacity and mint a fresh worker
  // enrollment, so they are entitlement-gated like provision requests.
  'environment.suspend': 'mutating',
  'environment.resume': 'mutating',
  // Grants are scoped to a claimed attempt's existing fence — delivery and
  // pull finish work that mutating job.claim already authorized.
  'credential.deliver': 'control',
  'credential.pull': 'control',
  // Task-key delivery finishes work job.create already authorized; pulls
  // are reads. Rotation reports and dashboard management are control-plane
  // rows — a restricted account must still revoke dashboard access.
  'taskkey.deliver': 'control',
  'taskkey.pull': 'control',
  'keyring.report': 'control',
  'dashboard.requests': 'control',
  'dashboard.decide': 'control',
  'dashboard.publish': 'control',
  'dashboard.revoke': 'control',
  'share.create': 'mutating',
  'share.finalize': 'control',
  'share.list': 'control',
  'share.revoke': 'control',
};

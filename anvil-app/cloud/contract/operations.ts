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
  'account.delete',
  'account.deletionStatus',
  // Devices
  'device.list',
  'device.rename',
  'device.revoke',
  'device.policy.publish',
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
] as const;

export type OperationName = (typeof OPERATIONS)[number];

export type OperationProfile = 'sync/1' | 'mesh/1';

export type ActorRole = 'user' | 'worker' | 'either';

export const OPERATION_PROFILE: Record<OperationName, OperationProfile> = {
  'session.describe': 'sync/1',
  'account.delete': 'sync/1',
  'account.deletionStatus': 'sync/1',
  'device.list': 'sync/1',
  'device.rename': 'sync/1',
  'device.revoke': 'sync/1',
  'device.policy.publish': 'sync/1',
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
};

/**
 * Which actor may invoke each operation. `user` is the initiating
 * controller, `worker` is the executing device reporting its own state,
 * `either` is safe for both (typically reads or generation-fenced writes).
 */
export const OPERATION_ROLE: Record<OperationName, ActorRole> = {
  'session.describe': 'either',
  'account.delete': 'user',
  'account.deletionStatus': 'user',
  'device.list': 'user',
  'device.rename': 'user',
  'device.revoke': 'user',
  'device.policy.publish': 'worker',
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
};

export function profileForOperation(operation: OperationName): OperationProfile {
  return OPERATION_PROFILE[operation];
}

export function requiredActorRole(operation: OperationName): ActorRole {
  return OPERATION_ROLE[operation];
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
  'account.delete': 'control',
  'account.deletionStatus': 'control',
  'device.list': 'control',
  'device.rename': 'control',
  'device.revoke': 'control',
  'device.policy.publish': 'mutating',
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
};

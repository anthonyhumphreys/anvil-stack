/**
 * A bounded, immutable snapshot of explicitly selected tracked source for a
 * remote read-only review. The diff is transported only inside sealed task
 * inputs; this type must never be copied into the public execution manifest.
 */
export const REMOTE_REVIEW_CANDIDATE_POLICY_VERSION = 'remote-review-candidate/v1' as const;
export const REMOTE_REVIEW_CANDIDATE_CAPABILITY = 'remote-review-candidate/v1' as const;
export const REMOTE_REVIEW_CAPABILITY_REQUIREMENTS_FEATURE =
  'mesh-job-capability-requirements/1' as const;
export const REMOTE_REVIEW_CANDIDATE_MAX_PAYLOAD_BYTES = 128 * 1024;
export const REMOTE_REVIEW_CANDIDATE_MAX_COUNT = 16;
export const REMOTE_REVIEW_CANDIDATE_MAX_FILES = 64;
export const REMOTE_REVIEW_CANDIDATE_MAX_FILE_BYTES = 512 * 1024;
export const REMOTE_REVIEW_CANDIDATE_MAX_TOTAL_FILE_BYTES = 2 * 1024 * 1024;

/**
 * The reviewed backend identity to which a current-tracked review approval is
 * bound. Keep the dataset epoch opaque: it is an identity fence, not a number.
 */
export interface RemoteReviewBackendBinding {
  backendId: string;
  baseUrl: string;
  apiUrl: string;
  accountId: string;
  datasetEpoch: string;
}

export function isRemoteReviewBackendBinding(value: unknown): value is RemoteReviewBackendBinding {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const expected = ['backendId', 'baseUrl', 'apiUrl', 'accountId', 'datasetEpoch'];
  return (
    Object.keys(record).length === expected.length &&
    expected.every(
      (key) =>
        typeof record[key] === 'string' &&
        (record[key] as string).length > 0 &&
        (record[key] as string).length <= 2048 &&
        !hasControlCharacters(record[key] as string),
    )
  );
}

export function remoteReviewBackendBindingsEqual(
  left: RemoteReviewBackendBinding,
  right: RemoteReviewBackendBinding,
): boolean {
  return (
    left.backendId === right.backendId &&
    left.baseUrl === right.baseUrl &&
    left.apiUrl === right.apiUrl &&
    left.accountId === right.accountId &&
    left.datasetEpoch === right.datasetEpoch
  );
}

export interface RemoteReviewCandidate {
  version: 1;
  policyVersion: typeof REMOTE_REVIEW_CANDIDATE_POLICY_VERSION;
  repositoryId: string;
  /** Public transport pin. The worker verifies this is the clone/worktree base. */
  baseCommit: string;
  /** Tree and canonical commit reconstructed from `patch` on the worker. */
  candidateTree: string;
  candidateCommit: string;
  /** Full-index, text-only git diff. This field is sensitive task input. */
  patch: string;
  patchSha256: string;
  /** Raw canonical Git commit object encoded as base64. */
  commitObjectBase64: string;
  /** Changed paths only, sorted by UTF-8 byte order. */
  includedPaths: string[];
  fileCount: number;
  /** Sum of resulting blob sizes for included paths (deleted paths add zero). */
  totalFileBytes: number;
}

export interface RemoteReviewCandidateSummary {
  repositoryId: string;
  baseCommit: string;
  candidateTree: string;
  candidateCommit: string;
  patchSha256: string;
  includedPaths: string[];
  fileCount: number;
  totalFileBytes: number;
}

export interface ValidateRemoteReviewCandidatesOptions {
  /** Candidate sources are valid only for an execution pinned to read-only. */
  readOnly: boolean;
  maxPayloadBytes?: number;
}

export type RemoteReviewCandidateIssue =
  | 'remote-review-candidate-read-only-required'
  | 'remote-review-candidate-capability-unsupported'
  | 'remote-review-candidate-invalid'
  | 'remote-review-candidate-too-large'
  | 'remote-review-candidate-duplicate-repository';

export class RemoteReviewCandidateValidationError extends Error {
  readonly code: RemoteReviewCandidateIssue;

  constructor(code: RemoteReviewCandidateIssue) {
    super(code);
    this.name = 'RemoteReviewCandidateValidationError';
    this.code = code;
  }
}

export function requireRemoteReviewCandidateReadOnly(permissionMode: unknown): void {
  if (permissionMode !== 'read-only') {
    throw new RemoteReviewCandidateValidationError('remote-review-candidate-read-only-required');
  }
}

export function supportsRemoteReviewCandidate(capabilities: readonly string[]): boolean {
  return capabilities.includes(REMOTE_REVIEW_CANDIDATE_CAPABILITY);
}

export function requireRemoteReviewCandidateCapability(capabilities: readonly string[]): void {
  if (!supportsRemoteReviewCandidate(capabilities)) {
    throw new RemoteReviewCandidateValidationError(
      'remote-review-candidate-capability-unsupported',
    );
  }
}

const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const SHA256 = /^[a-f0-9]{64}$/i;

function invalid(): never {
  throw new RemoteReviewCandidateValidationError('remote-review-candidate-invalid');
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charCodeAt(index);
    if (character <= 0x1f || character === 0x7f) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

/** Shared path policy used by capture and worker validation. */
export function isRemoteReviewCandidatePathAllowed(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 1024 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    hasControlCharacters(value)
  ) {
    return false;
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return false;
  }
  return !segments.some((segment) => {
    const lower = segment.toLowerCase();
    if (
      lower === '.git' ||
      lower === '.npmrc' ||
      lower === '.netrc' ||
      lower === '.pypirc' ||
      lower === '.aws' ||
      lower === '.ssh'
    ) {
      return true;
    }
    if (
      lower === '.env' ||
      (lower.startsWith('.env.') &&
        !['.env.example', '.env.sample', '.env.template'].includes(lower))
    ) {
      return true;
    }
    if (lower.includes('credential') || lower.includes('secret')) return true;
    return (
      /\.(?:pem|key|p12|pfx|keystore|jks)$/i.test(lower) ||
      lower === 'id_rsa' ||
      lower === 'id_ed25519'
    );
  });
}

function candidateIssue(value: unknown): value is RemoteReviewCandidate {
  if (!isRecord(value)) return false;
  const candidate = value;
  const expectedKeys = [
    'version',
    'policyVersion',
    'repositoryId',
    'baseCommit',
    'candidateTree',
    'candidateCommit',
    'patch',
    'patchSha256',
    'commitObjectBase64',
    'includedPaths',
    'fileCount',
    'totalFileBytes',
  ];
  if (
    Object.keys(candidate).length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(candidate, key)) ||
    candidate['version'] !== 1 ||
    candidate['policyVersion'] !== REMOTE_REVIEW_CANDIDATE_POLICY_VERSION ||
    typeof candidate['repositoryId'] !== 'string' ||
    candidate['repositoryId'].length === 0 ||
    candidate['repositoryId'].length > 200 ||
    hasControlCharacters(candidate['repositoryId']) ||
    typeof candidate['baseCommit'] !== 'string' ||
    !OBJECT_ID.test(candidate['baseCommit']) ||
    typeof candidate['candidateTree'] !== 'string' ||
    !OBJECT_ID.test(candidate['candidateTree']) ||
    typeof candidate['candidateCommit'] !== 'string' ||
    !OBJECT_ID.test(candidate['candidateCommit']) ||
    typeof candidate['patch'] !== 'string' ||
    candidate['patch'].length === 0 ||
    typeof candidate['patchSha256'] !== 'string' ||
    !SHA256.test(candidate['patchSha256']) ||
    typeof candidate['commitObjectBase64'] !== 'string' ||
    candidate['commitObjectBase64'].length === 0 ||
    candidate['commitObjectBase64'].length > 16 * 1024 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      candidate['commitObjectBase64'],
    ) ||
    !Array.isArray(candidate['includedPaths']) ||
    !candidate['includedPaths'].every(
      (path): path is string =>
        typeof path === 'string' && isRemoteReviewCandidatePathAllowed(path),
    ) ||
    !Number.isInteger(candidate['fileCount']) ||
    typeof candidate['fileCount'] !== 'number' ||
    !Number.isInteger(candidate['totalFileBytes']) ||
    typeof candidate['totalFileBytes'] !== 'number'
  ) {
    return false;
  }
  const paths = candidate['includedPaths'] as string[];
  return (
    paths.length > 0 &&
    paths.length <= REMOTE_REVIEW_CANDIDATE_MAX_FILES &&
    candidate['fileCount'] === paths.length &&
    candidate['totalFileBytes'] >= 0 &&
    candidate['totalFileBytes'] <= REMOTE_REVIEW_CANDIDATE_MAX_TOTAL_FILE_BYTES &&
    paths.every((path, index) => index === 0 || compareUtf8(paths[index - 1]!, path) < 0) &&
    candidate['baseCommit'].length === candidate['candidateTree'].length &&
    candidate['baseCommit'].length === candidate['candidateCommit'].length &&
    new TextEncoder().encode(candidate['patch']).byteLength <=
      REMOTE_REVIEW_CANDIDATE_MAX_PAYLOAD_BYTES
  );
}

/** Validates structure, policy, and aggregate JSON payload size without exposing patch text. */
export function validateRemoteReviewCandidates(
  candidates: readonly RemoteReviewCandidate[],
  options: ValidateRemoteReviewCandidatesOptions,
): void {
  if (!Array.isArray(candidates) || candidates.length === 0) invalid();
  if (options.readOnly !== true) {
    throw new RemoteReviewCandidateValidationError('remote-review-candidate-read-only-required');
  }
  if (candidates.length > REMOTE_REVIEW_CANDIDATE_MAX_COUNT || !candidates.every(candidateIssue)) {
    invalid();
  }
  const repositories = new Set<string>();
  let totalFiles = 0;
  let totalFileBytes = 0;
  for (const candidate of candidates) {
    if (repositories.has(candidate.repositoryId)) {
      throw new RemoteReviewCandidateValidationError(
        'remote-review-candidate-duplicate-repository',
      );
    }
    repositories.add(candidate.repositoryId);
    totalFiles += candidate.fileCount;
    totalFileBytes += candidate.totalFileBytes;
    if (
      totalFiles > REMOTE_REVIEW_CANDIDATE_MAX_FILES ||
      totalFileBytes > REMOTE_REVIEW_CANDIDATE_MAX_TOTAL_FILE_BYTES
    ) {
      throw new RemoteReviewCandidateValidationError('remote-review-candidate-too-large');
    }
  }
  const payloadBytes = new TextEncoder().encode(JSON.stringify(candidates)).byteLength;
  if (payloadBytes > (options.maxPayloadBytes ?? REMOTE_REVIEW_CANDIDATE_MAX_PAYLOAD_BYTES)) {
    throw new RemoteReviewCandidateValidationError('remote-review-candidate-too-large');
  }
}

/** Produces metadata suitable for UI approval; source bytes and patch are omitted. */
export function describeRemoteReviewCandidate(
  candidate: RemoteReviewCandidate,
): RemoteReviewCandidateSummary {
  validateRemoteReviewCandidates([candidate], { readOnly: true });
  return {
    repositoryId: candidate.repositoryId,
    baseCommit: candidate.baseCommit,
    candidateTree: candidate.candidateTree,
    candidateCommit: candidate.candidateCommit,
    patchSha256: candidate.patchSha256,
    includedPaths: [...candidate.includedPaths],
    fileCount: candidate.fileCount,
    totalFileBytes: candidate.totalFileBytes,
  };
}

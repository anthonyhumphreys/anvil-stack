import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  realpathSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { scanForSecrets } from './share-secret-scan.js';
import {
  isRemoteReviewCandidatePathAllowed,
  REMOTE_REVIEW_CANDIDATE_MAX_FILE_BYTES,
  REMOTE_REVIEW_CANDIDATE_MAX_FILES,
  REMOTE_REVIEW_CANDIDATE_MAX_PAYLOAD_BYTES,
  REMOTE_REVIEW_CANDIDATE_MAX_TOTAL_FILE_BYTES,
  REMOTE_REVIEW_CANDIDATE_POLICY_VERSION,
  validateRemoteReviewCandidates,
  type RemoteReviewCandidate,
} from '../../shared/remote-review-candidate.js';

const GIT_TIMEOUT_MS = 10_000;
const MAX_COMMIT_OBJECT_BYTES = 8 * 1024;
const REVIEW_AUTHOR = 'Mezair Remote Review <remote-review@mezair.local>';
const REVIEW_COMMIT_DATE = '946684800 +0000';
const REVIEW_COMMIT_MESSAGE = 'Remote review candidate v1\n';

export interface CaptureRemoteReviewCandidateInput {
  repositoryId: string;
  repositoryPath: string;
  /** Exact repository-relative paths. An empty selection is rejected. */
  selectedPaths: readonly string[];
  /** Defaults to the repository HEAD captured at the beginning of the operation. */
  baseCommit?: string;
}

export class RemoteReviewCandidateError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'RemoteReviewCandidateError';
    this.code = code;
  }
}

function fail(code: string): never {
  throw new RemoteReviewCandidateError(code);
}

function gitEnvironment(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    ...overrides,
  };
}

async function gitBytes(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; maxBuffer?: number; input?: Buffer } = {},
): Promise<Buffer> {
  return new Promise<Buffer>((resolveResult, rejectResult) => {
    const child = spawn('git', args, {
      cwd,
      env: options.env ?? gitEnvironment(),
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    const maxBuffer = options.maxBuffer ?? 2 * 1024 * 1024;
    let outputBytes = 0;
    let rejected = false;
    const timer = setTimeout(() => {
      rejected = true;
      child.kill('SIGKILL');
      rejectResult(new RemoteReviewCandidateError('remote-review-candidate-git-timeout'));
    }, GIT_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.byteLength;
      if (outputBytes > maxBuffer) {
        rejected = true;
        child.kill('SIGKILL');
        rejectResult(new RemoteReviewCandidateError('remote-review-candidate-output-too-large'));
        return;
      }
      chunks.push(bytes);
    });
    child.once('error', () => {
      if (rejected) return;
      rejected = true;
      clearTimeout(timer);
      rejectResult(new RemoteReviewCandidateError('remote-review-candidate-git-operation-failed'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (rejected) return;
      if (code !== 0) {
        rejectResult(
          new RemoteReviewCandidateError('remote-review-candidate-git-operation-failed'),
        );
        return;
      }
      resolveResult(Buffer.concat(chunks));
    });
    child.stdin.end(options.input);
  });
}

async function gitText(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; maxBuffer?: number; input?: Buffer } = {},
): Promise<string> {
  return (await gitBytes(cwd, args, options)).toString('utf8').trimEnd();
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function validateRepositoryId(value: string): void {
  let hasControlCharacter = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charCodeAt(index);
    if (character <= 0x1f || character === 0x7f) {
      hasControlCharacter = true;
      break;
    }
  }
  if (value.length === 0 || value.length > 200 || hasControlCharacter) {
    fail('remote-review-candidate-invalid-repository');
  }
}

function validateSelection(paths: readonly string[]): string[] {
  if (
    !Array.isArray(paths) ||
    paths.length === 0 ||
    paths.length > REMOTE_REVIEW_CANDIDATE_MAX_FILES
  ) {
    fail('remote-review-candidate-invalid-selection');
  }
  const seen = new Set<string>();
  for (const path of paths) {
    if (typeof path !== 'string' || !isRemoteReviewCandidatePathAllowed(path) || seen.has(path)) {
      fail('remote-review-candidate-invalid-selection');
    }
    seen.add(path);
  }
  return [...seen].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function assertNoSymlinkComponents(root: string, relativePath: string): void {
  let current = root;
  const components = relativePath.split('/');
  for (let index = 0; index < components.length; index += 1) {
    current = join(current, components[index]!);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) fail('remote-review-candidate-unsupported-file-type');
      if (index < components.length - 1 && !stat.isDirectory()) {
        fail('remote-review-candidate-invalid-selection');
      }
    } catch (error) {
      if (error instanceof RemoteReviewCandidateError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return; // A missing tracked path is a deletion.
      fail('remote-review-candidate-file-unavailable');
    }
  }
}

function readBoundedRegularFile(path: string): { bytes: Buffer; mode: '100644' | '100755' } {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      fail('remote-review-candidate-file-unavailable');
    }
    fail('remote-review-candidate-file-unavailable');
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) fail('remote-review-candidate-unsupported-file-type');
    if (stat.size > REMOTE_REVIEW_CANDIDATE_MAX_FILE_BYTES) {
      fail('remote-review-candidate-file-too-large');
    }
    const bytes = Buffer.alloc(REMOTE_REVIEW_CANDIDATE_MAX_FILE_BYTES + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, bytes, length, bytes.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > REMOTE_REVIEW_CANDIDATE_MAX_FILE_BYTES) {
        fail('remote-review-candidate-file-too-large');
      }
    }
    return {
      bytes: bytes.subarray(0, length),
      mode: (stat.mode & 0o111) === 0 ? '100644' : '100755',
    };
  } finally {
    closeSync(fd);
  }
}

function assertTextBlob(bytes: Buffer): string {
  if (bytes.includes(0)) fail('remote-review-candidate-binary-file');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('remote-review-candidate-binary-file');
  }
}

function parseNulRecords(bytes: Buffer): string[] {
  if (bytes.length === 0) return [];
  if (bytes[bytes.length - 1] !== 0) fail('remote-review-candidate-git-output-invalid');
  return bytes.subarray(0, -1).toString('utf8').split('\0');
}

function parseTreeEntry(record: string): { mode: string; objectId: string; path: string } {
  const tab = record.indexOf('\t');
  const metadata = tab < 0 ? '' : record.slice(0, tab);
  const path = tab < 0 ? '' : record.slice(tab + 1);
  const [mode = '', type = '', objectId = ''] = metadata.split(' ');
  if (type !== 'blob' || path.length === 0 || !/^[a-f0-9]{40,64}$/i.test(objectId)) {
    fail('remote-review-candidate-untracked-or-unsupported-file');
  }
  return { mode, objectId, path };
}

function canonicalCommitObject(tree: string, parent: string): Buffer {
  return Buffer.from(
    `tree ${tree}\nparent ${parent}\nauthor ${REVIEW_AUTHOR} ${REVIEW_COMMIT_DATE}\ncommitter ${REVIEW_AUTHOR} ${REVIEW_COMMIT_DATE}\n\n${REVIEW_COMMIT_MESSAGE}`,
    'utf8',
  );
}

async function withTemporaryIndex<T>(
  repositoryPath: string,
  baseCommit: string,
  run: (input: { env: NodeJS.ProcessEnv; root: string }) => Promise<T>,
): Promise<T> {
  const tempRoot = mkdtempSync(join(tmpdir(), 'mezair-remote-review-'));
  const objectDirectory = join(tempRoot, 'objects');
  mkdirSync(join(objectDirectory, 'info'), { recursive: true });
  const commonDirectory = await gitText(repositoryPath, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  writeFileSync(
    join(objectDirectory, 'info', 'alternates'),
    `${join(commonDirectory, 'objects')}\n`,
    {
      mode: 0o600,
    },
  );
  const indexPath = join(tempRoot, 'index');
  const env = gitEnvironment({ GIT_INDEX_FILE: indexPath, GIT_OBJECT_DIRECTORY: objectDirectory });
  try {
    await gitBytes(repositoryPath, ['read-tree', baseCommit], { env });
    return await run({ env, root: tempRoot });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

/**
 * Freezes explicitly selected tracked regular files relative to a fixed HEAD.
 * Staged and unrelated changes are excluded through a temporary index; no
 * working-tree, ref, or real-index mutation is performed.
 */
export async function captureRemoteReviewCandidate(
  input: CaptureRemoteReviewCandidateInput,
): Promise<RemoteReviewCandidate> {
  validateRepositoryId(input.repositoryId);
  const repositoryPath = resolve(input.repositoryPath);
  let realRepositoryPath: string;
  try {
    realRepositoryPath = realpathSync(repositoryPath);
  } catch {
    fail('remote-review-candidate-invalid-repository-path');
  }
  if (!isAbsolute(repositoryPath)) fail('remote-review-candidate-invalid-repository-path');
  const selectedPaths = validateSelection(input.selectedPaths);
  const head = await gitText(repositoryPath, ['rev-parse', 'HEAD']);
  const requestedBase = input.baseCommit ?? head;
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(requestedBase)) {
    fail('remote-review-candidate-invalid-base');
  }
  const baseCommit = await gitText(repositoryPath, [
    'rev-parse',
    '--verify',
    `${requestedBase}^{commit}`,
  ]);
  const conflicts = await gitBytes(repositoryPath, ['ls-files', '--unmerged', '-z']);
  if (conflicts.length > 0) fail('remote-review-candidate-conflicted-index');

  // Stage-0 index records let us safely distinguish an explicitly staged new
  // file from an untracked path. Their blob contents are deliberately ignored:
  // the captured candidate always uses the current regular worktree bytes.
  const realIndexEnv = gitEnvironment({
    GIT_INDEX_FILE: undefined,
    GIT_OBJECT_DIRECTORY: undefined,
  });
  const stagedAdditions = new Map<string, { mode: string; objectId: string }>();
  for (const path of selectedPaths) {
    const records = parseNulRecords(
      await gitBytes(repositoryPath, ['ls-files', '--stage', '-z', '--', `:(literal)${path}`], {
        env: realIndexEnv,
      }),
    );
    const parsed = records.map((record) => {
      const tab = record.indexOf('\t');
      const metadata = tab < 0 ? '' : record.slice(0, tab);
      const indexedPath = tab < 0 ? '' : record.slice(tab + 1);
      const [mode = '', objectId = '', stage = ''] = metadata.split(' ');
      return { mode, objectId, stage, path: indexedPath };
    });
    if (parsed.some((record) => record.stage !== '0')) {
      fail('remote-review-candidate-conflicted-index');
    }
    if (parsed.length > 1) fail('remote-review-candidate-ambiguous-selection');
    const staged = parsed[0];
    if (staged !== undefined) {
      if (
        staged.path !== path ||
        (staged.mode !== '100644' && staged.mode !== '100755') ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(staged.objectId) ||
        /^0+$/.test(staged.objectId)
      ) {
        fail('remote-review-candidate-untracked-or-unsupported-file');
      }
      stagedAdditions.set(path, { mode: staged.mode, objectId: staged.objectId });
    }
  }

  // A sparse checkout or symlinked parent can make a nominally tracked path
  // resolve outside the repository. Refuse it before reading local bytes.
  for (const path of selectedPaths) assertNoSymlinkComponents(realRepositoryPath, path);

  return withTemporaryIndex(repositoryPath, baseCommit, async ({ env }) => {
    const baseEntries = new Map<string, ReturnType<typeof parseTreeEntry>>();
    for (const path of selectedPaths) {
      const records = parseNulRecords(
        await gitBytes(repositoryPath, ['ls-tree', '-z', baseCommit, '--', `:(literal)${path}`], {
          env,
        }),
      );
      const exact = records.map(parseTreeEntry).filter((entry) => entry.path === path);
      if (exact.length === 0) {
        // A selected path absent from the pinned base is included only when
        // the real index explicitly tracks it at stage 0. Untracked files and
        // intent-to-add entries are never candidate sources.
        const stagedAddition = stagedAdditions.get(path);
        if (stagedAddition === undefined) {
          fail('remote-review-candidate-untracked-or-unsupported-file');
        }
        baseEntries.set(path, {
          mode: stagedAddition.mode,
          objectId: stagedAddition.objectId,
          path,
        });
        continue;
      }
      if (exact.length !== 1) fail('remote-review-candidate-ambiguous-selection');
      const entry = exact[0]!;
      if (entry.mode !== '100644' && entry.mode !== '100755') {
        fail('remote-review-candidate-unsupported-file-mode');
      }
      baseEntries.set(path, entry);
    }

    for (const entry of baseEntries.values()) {
      const size = Number(
        await gitText(repositoryPath, ['cat-file', '-s', entry.objectId], { env }),
      );
      if (!Number.isSafeInteger(size) || size > REMOTE_REVIEW_CANDIDATE_MAX_FILE_BYTES) {
        fail('remote-review-candidate-file-too-large');
      }
      const bytes = await gitBytes(repositoryPath, ['cat-file', 'blob', entry.objectId], {
        env,
        maxBuffer: REMOTE_REVIEW_CANDIDATE_MAX_FILE_BYTES,
      });
      assertTextBlob(bytes);
    }

    for (const path of selectedPaths) {
      if (!baseEntries.has(path)) fail('remote-review-candidate-untracked-or-unsupported-file');
      const absolutePath = join(repositoryPath, ...path.split('/'));
      const relativePath = relative(repositoryPath, absolutePath);
      if (
        relativePath === '..' ||
        relativePath.startsWith(`..${sep}`) ||
        isAbsolute(relativePath)
      ) {
        fail('remote-review-candidate-invalid-selection');
      }
      assertNoSymlinkComponents(realRepositoryPath, path);
      let newBytes: Buffer;
      let newMode: '100644' | '100755';
      try {
        lstatSync(absolutePath);
        const file = readBoundedRegularFile(absolutePath);
        newBytes = file.bytes;
        newMode = file.mode;
      } catch (error) {
        if (error instanceof RemoteReviewCandidateError) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          fail('remote-review-candidate-file-unavailable');
        }
        if (
          !parseNulRecords(
            await gitBytes(
              repositoryPath,
              ['ls-tree', '-z', baseCommit, '--', `:(literal)${path}`],
              { env },
            ),
          ).length
        ) {
          fail('remote-review-candidate-file-unavailable');
        }
        await gitBytes(repositoryPath, ['update-index', '--force-remove', '--', path], { env });
        continue;
      }
      assertTextBlob(newBytes);
      const blobId = await gitText(
        repositoryPath,
        ['hash-object', '-w', '--no-filters', '--stdin'],
        { env, input: newBytes },
      );
      if (!/^[a-f0-9]{40,64}$/i.test(blobId)) fail('remote-review-candidate-git-output-invalid');
      const indexInfo = Buffer.from(`${newMode} ${blobId}\t${path}\0`, 'utf8');
      await gitBytes(repositoryPath, ['update-index', '-z', '--index-info'], {
        env,
        input: indexInfo,
      });
    }

    const nameArgs = selectedPaths.map((path) => `:(literal)${path}`);
    const includedPaths = parseNulRecords(
      await gitBytes(
        repositoryPath,
        [
          '-c',
          'diff.renames=false',
          'diff',
          '--cached',
          '--name-only',
          '-z',
          baseCommit,
          '--',
          ...nameArgs,
        ],
        { env },
      ),
    ).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    if (includedPaths.length === 0 || includedPaths.length > REMOTE_REVIEW_CANDIDATE_MAX_FILES) {
      fail('remote-review-candidate-empty-or-too-many-files');
    }
    for (const path of includedPaths) {
      if (!selectedPaths.includes(path) || !isRemoteReviewCandidatePathAllowed(path)) {
        fail('remote-review-candidate-invalid-selection');
      }
    }

    const indexEntries = new Map<string, { mode: string; objectId: string }>();
    const stagedRecords = parseNulRecords(
      await gitBytes(repositoryPath, ['ls-files', '--stage', '-z', '--', ...nameArgs], { env }),
    );
    for (const record of stagedRecords) {
      const tab = record.indexOf('\t');
      const metadata = tab < 0 ? '' : record.slice(0, tab);
      const path = tab < 0 ? '' : record.slice(tab + 1);
      const [mode = '', objectId = '', stage = ''] = metadata.split(' ');
      if (stage !== '0' || (mode !== '100644' && mode !== '100755')) {
        fail('remote-review-candidate-unsupported-file-mode');
      }
      indexEntries.set(path, { mode, objectId });
    }

    let totalFileBytes = 0;
    for (const path of includedPaths) {
      const staged = indexEntries.get(path);
      if (staged === undefined) continue; // A deletion contributes no result bytes.
      const size = Number(
        await gitText(repositoryPath, ['cat-file', '-s', staged.objectId], { env }),
      );
      if (!Number.isSafeInteger(size) || size > REMOTE_REVIEW_CANDIDATE_MAX_FILE_BYTES) {
        fail('remote-review-candidate-file-too-large');
      }
      totalFileBytes += size;
      if (totalFileBytes > REMOTE_REVIEW_CANDIDATE_MAX_TOTAL_FILE_BYTES) {
        fail('remote-review-candidate-files-too-large');
      }
      const blob = await gitBytes(repositoryPath, ['cat-file', 'blob', staged.objectId], {
        env,
        maxBuffer: REMOTE_REVIEW_CANDIDATE_MAX_FILE_BYTES + 1,
      });
      assertTextBlob(blob);
    }

    let patch: string;
    try {
      patch = (
        await gitBytes(
          repositoryPath,
          [
            '-c',
            'diff.renames=false',
            'diff',
            '--cached',
            '--full-index',
            '--no-ext-diff',
            '--no-textconv',
            '--no-color',
            '--unified=3',
            baseCommit,
            '--',
            ...nameArgs,
          ],
          { env, maxBuffer: REMOTE_REVIEW_CANDIDATE_MAX_PAYLOAD_BYTES },
        )
      ).toString('utf8');
    } catch {
      fail('remote-review-candidate-patch-invalid-or-too-large');
    }
    if (
      patch.length === 0 ||
      patch.includes('Binary files ') ||
      patch.includes('GIT binary patch') ||
      Buffer.byteLength(patch, 'utf8') > REMOTE_REVIEW_CANDIDATE_MAX_PAYLOAD_BYTES
    ) {
      fail('remote-review-candidate-patch-invalid-or-too-large');
    }
    let inHunk = false;
    const patchContentLines: string[] = [];
    for (const line of patch.split('\n')) {
      if (line.startsWith('diff --git ')) {
        inHunk = false;
        continue;
      }
      if (line.startsWith('@@')) {
        inHunk = true;
        continue;
      }
      if (inHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
        patchContentLines.push(line.slice(1));
      }
    }
    if (scanForSecrets(patchContentLines.join('\n')).length > 0) {
      fail('remote-review-candidate-secret-content');
    }

    const candidateTree = await gitText(repositoryPath, ['write-tree'], { env });
    if (!/^[a-f0-9]{40,64}$/i.test(candidateTree))
      fail('remote-review-candidate-git-output-invalid');
    const rawCommit = canonicalCommitObject(candidateTree, baseCommit);
    if (rawCommit.byteLength > MAX_COMMIT_OBJECT_BYTES) {
      fail('remote-review-candidate-commit-invalid');
    }
    const candidateCommit = await gitText(
      repositoryPath,
      ['hash-object', '-t', 'commit', '--stdin'],
      { env, input: rawCommit },
    );
    if (!/^[a-f0-9]{40,64}$/i.test(candidateCommit)) {
      fail('remote-review-candidate-git-output-invalid');
    }

    const candidate: RemoteReviewCandidate = {
      version: 1,
      policyVersion: REMOTE_REVIEW_CANDIDATE_POLICY_VERSION,
      repositoryId: input.repositoryId,
      baseCommit,
      candidateTree,
      candidateCommit,
      patch,
      patchSha256: sha256(patch),
      commitObjectBase64: rawCommit.toString('base64'),
      includedPaths,
      fileCount: includedPaths.length,
      totalFileBytes,
    };
    validateRemoteReviewCandidates([candidate], { readOnly: true });
    return candidate;
  });
}

export interface MaterializeRemoteReviewCandidateInput {
  candidate: RemoteReviewCandidate;
  /** A clean isolated attempt worktree at `candidate.baseCommit`. */
  repositoryPath: string;
}

function decodeCommitObject(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value || decoded.length > MAX_COMMIT_OBJECT_BYTES) {
    fail('remote-review-candidate-commit-invalid');
  }
  return decoded;
}

async function assertCleanRepository(cwd: string): Promise<void> {
  const status = await gitText(cwd, ['status', '--porcelain', '--untracked-files=all']);
  if (status.length > 0) fail('remote-review-candidate-worktree-not-clean');
}

/** Applies the sealed patch in an isolated worktree and pins it at candidateCommit. */
export async function materializeRemoteReviewCandidate(
  input: MaterializeRemoteReviewCandidateInput,
): Promise<{ repositoryId: string; baseCommit: string; candidateCommit: string }> {
  validateRemoteReviewCandidates([input.candidate], { readOnly: true });
  const { candidate } = input;
  const repositoryPath = resolve(input.repositoryPath);
  const head = await gitText(repositoryPath, ['rev-parse', 'HEAD']);
  if (head !== candidate.baseCommit) fail('remote-review-candidate-base-mismatch');
  await assertCleanRepository(repositoryPath);
  const patchBytes = Buffer.from(candidate.patch, 'utf8');
  if (sha256(patchBytes) !== candidate.patchSha256) {
    fail('remote-review-candidate-patch-digest-mismatch');
  }

  const rawCommit = decodeCommitObject(candidate.commitObjectBase64);
  const expectedCommit = canonicalCommitObject(candidate.candidateTree, candidate.baseCommit);
  if (!rawCommit.equals(expectedCommit)) fail('remote-review-candidate-commit-invalid');

  const tempPatch = join(tmpdir(), `mezair-remote-review-${randomUUID()}.patch`);
  try {
    writeFileSync(tempPatch, patchBytes, { mode: 0o600, flag: 'wx' });
    await gitBytes(repositoryPath, [
      'apply',
      '--index',
      '--no-3way',
      '--whitespace=nowarn',
      tempPatch,
    ]);
    const tree = await gitText(repositoryPath, ['write-tree']);
    if (tree !== candidate.candidateTree) fail('remote-review-candidate-tree-mismatch');

    const writtenCommit = await gitText(
      repositoryPath,
      ['hash-object', '-t', 'commit', '-w', '--stdin'],
      { input: rawCommit },
    );
    if (writtenCommit !== candidate.candidateCommit) {
      fail('remote-review-candidate-commit-mismatch');
    }
    const changedPaths = parseNulRecords(
      await gitBytes(repositoryPath, [
        'diff-tree',
        '--no-commit-id',
        '--name-only',
        '-r',
        '-z',
        candidate.baseCommit,
        candidate.candidateCommit,
      ]),
    ).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    if (
      changedPaths.length !== candidate.includedPaths.length ||
      changedPaths.some((path, index) => path !== candidate.includedPaths[index])
    ) {
      fail('remote-review-candidate-path-mismatch');
    }

    await gitBytes(repositoryPath, ['reset', '--hard', candidate.candidateCommit]);
    const materializedHead = await gitText(repositoryPath, ['rev-parse', 'HEAD']);
    if (materializedHead !== candidate.candidateCommit) {
      fail('remote-review-candidate-commit-mismatch');
    }
    await assertCleanRepository(repositoryPath);
    return {
      repositoryId: candidate.repositoryId,
      baseCommit: candidate.baseCommit,
      candidateCommit: candidate.candidateCommit,
    };
  } finally {
    rmSync(tempPatch, { force: true });
  }
}

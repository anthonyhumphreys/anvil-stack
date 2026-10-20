import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveAppReleaseTarget } from './resolve-app-release-target.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const resolverPath = path.join(scriptDirectory, 'resolve-app-release-target.mjs');
const ensureTargetPath = path.join(scriptDirectory, 'ensure-app-release-target.sh');
const workflowPath = path.resolve(scriptDirectory, '../workflows/app-release-macos-arm64.yml');
const buildSha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);

function target(overrides = {}) {
  return {
    packageVersion: '1.2.3',
    refName: 'main',
    refType: 'branch',
    requestedTag: '',
    buildSha,
    existingTagCommit: null,
    ...overrides,
  };
}

function withTempDir(callback) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'anvil-release-target-'));
  try {
    return callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('resolves an absent manual tag to the candidate version and build SHA', () => {
  assert.deepEqual(resolveAppReleaseTarget(target()), {
    tag: 'app-v1.2.3',
    name: 'Anvil app-v1.2.3',
    tagExists: false,
  });
});

test('accepts an existing tag only when it points to the build commit', () => {
  assert.equal(
    resolveAppReleaseTarget(target({ existingTagCommit: buildSha })).tagExists,
    true,
  );
  assert.throws(
    () => resolveAppReleaseTarget(target({ existingTagCommit: otherSha })),
    /Refusing to publish artifacts under a different commit's tag/,
  );
});

test('rejects a requested version mismatch and a conflicting tag-trigger input', () => {
  assert.throws(
    () => resolveAppReleaseTarget(target({ requestedTag: 'app-v9.9.9' })),
    /does not match package.json version/,
  );
  assert.throws(
    () =>
      resolveAppReleaseTarget(
        target({
          refName: 'app-v1.2.3',
          refType: 'tag',
          requestedTag: 'app-v9.9.9',
          existingTagCommit: buildSha,
        }),
      ),
    /does not match triggering tag/,
  );
});

test('rejects package versions that could escape the release tag output', () => {
  assert.throws(
    () => resolveAppReleaseTarget(target({ packageVersion: '1.2.3\nother=value' })),
    /cannot be used in a release tag/,
  );
});

test('requires the triggering tag to exist and resolve to the triggering commit', () => {
  assert.throws(
    () => resolveAppReleaseTarget(target({ refName: 'app-v1.2.3', refType: 'tag' })),
    /is missing from the remote repository/,
  );
  assert.throws(
    () =>
      resolveAppReleaseTarget(
        target({
          refName: 'app-v1.2.3',
          refType: 'tag',
          existingTagCommit: otherSha,
        }),
      ),
    /different commit's tag/,
  );
});

test('the resolver reads the remote tag before the workflow build', () => {
  withTempDir((directory) => {
    const origin = path.join(directory, 'origin.git');
    execFileSync('git', ['init', '--quiet', directory]);
    execFileSync('git', ['init', '--bare', '--quiet', origin]);
    execFileSync('git', ['-C', directory, 'config', 'user.email', 'release-test@example.invalid']);
    execFileSync('git', ['-C', directory, 'config', 'user.name', 'Release Test']);
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    execFileSync('git', ['-C', directory, 'add', 'package.json']);
    execFileSync('git', ['-C', directory, 'commit', '--quiet', '-m', 'candidate']);
    execFileSync('git', ['-C', directory, 'branch', '-M', 'main']);
    execFileSync('git', ['-C', directory, 'remote', 'add', 'origin', origin]);
    execFileSync('git', ['-C', directory, 'push', '--quiet', '--set-upstream', 'origin', 'main']);
    const commit = execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['-C', directory, 'tag', 'app-v1.2.3', commit]);
    execFileSync('git', ['-C', directory, 'push', '--quiet', 'origin', 'app-v1.2.3']);

    const outputPath = path.join(directory, 'github-output.txt');
    const env = {
      ...process.env,
      GITHUB_OUTPUT: outputPath,
      GITHUB_REF_NAME: 'main',
      GITHUB_REF_TYPE: 'branch',
      GITHUB_SHA: commit,
      INPUT_RELEASE_TAG: 'app-v1.2.3',
    };
    const result = spawnSync(process.execPath, [resolverPath], {
      cwd: directory,
      encoding: 'utf8',
      env,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(outputPath, 'utf8'), /tag_exists=true/);

    const secondCommit = execFileSync('git', ['-C', directory, 'commit', '--allow-empty', '--quiet', '-m', 'other']);
    assert.ok(secondCommit);
    execFileSync('git', ['-C', directory, 'tag', '--force', 'app-v1.2.3', 'HEAD']);
    execFileSync('git', ['-C', directory, 'push', '--quiet', '--force', 'origin', 'app-v1.2.3']);
    const mismatch = spawnSync(process.execPath, [resolverPath], {
      cwd: directory,
      encoding: 'utf8',
      env,
    });
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /Refusing to publish artifacts under a different commit's tag/);
  });
});

function makeReleaseCommandMocks(directory) {
  const mockBin = path.join(directory, 'bin');
  mkdirSync(mockBin);
  const createdTagPath = path.join(directory, 'created-tag-sha');
  const ghLogPath = path.join(directory, 'gh.log');
  writeFileSync(
    path.join(mockBin, 'git'),
    `#!/usr/bin/env bash
set -euo pipefail
[[ "\${MOCK_REMOTE_FAILURE:-false}" != 'true' ]] || exit 1
tag_ref="\${5}"
peeled_ref="\${6}"
if [[ -f "\${MOCK_CREATED_TAG_PATH}" ]]; then
  commit="$(cat "\${MOCK_CREATED_TAG_PATH}")"
elif [[ -n "\${MOCK_REMOTE_SHA:-}" ]]; then
  commit="\${MOCK_REMOTE_SHA}"
else
  exit 0
fi
if [[ "\${MOCK_REMOTE_ANNOTATED:-false}" == 'true' ]]; then
  printf '%s\t%s\n%s\t%s\n' "\${MOCK_TAG_OBJECT_SHA:-${otherSha}}" "\${tag_ref}" "\${commit}" "\${peeled_ref}"
else
  printf '%s\t%s\n' "\${commit}" "\${tag_ref}"
fi
`,
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(mockBin, 'gh'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "\${MOCK_GH_LOG_PATH}"
if [[ "$1" == 'release' && "$2" == 'view' ]]; then
  [[ "\${MOCK_RELEASE_EXISTS:-false}" == 'true' ]]
  exit
fi
if [[ "$1" == 'release' && "$2" == 'create' ]]; then
  shift 2
  while [[ "$#" -gt 0 ]]; do
    if [[ "$1" == '--target' ]]; then
      target="$2"
      printf '%s' "\${MOCK_CREATE_SHA:-\${target}}" > "\${MOCK_CREATED_TAG_PATH}"
      exit 0
    fi
    shift
  done
  exit 0
fi
exit 2
`,
    { mode: 0o755 },
  );
  chmodSync(path.join(mockBin, 'git'), 0o755);
  chmodSync(path.join(mockBin, 'gh'), 0o755);
  const workspace = path.join(directory, 'workspace');
  mkdirSync(workspace);
  const notesPath = path.join(directory, 'notes.md');
  writeFileSync(notesPath, 'Release candidate notes\n');

  return {
    env: {
      ...process.env,
      GITHUB_WORKSPACE: workspace,
      MOCK_CREATED_TAG_PATH: createdTagPath,
      MOCK_GH_LOG_PATH: ghLogPath,
      PATH: `${mockBin}:${process.env.PATH}`,
    },
    createdTagPath,
    ghLogPath,
    notesPath,
  };
}

function runEnsureTarget(directory, envOverrides = {}, tagExisted = 'false') {
  const mocks = makeReleaseCommandMocks(directory);
  const result = spawnSync(
    'bash',
    [ensureTargetPath, 'app-v1.2.3', buildSha, tagExisted, 'Anvil app-v1.2.3', mocks.notesPath],
    {
      encoding: 'utf8',
      env: { ...mocks.env, ...envOverrides },
    },
  );
  const log = existsSync(mocks.ghLogPath)
    ? readFileSync(mocks.ghLogPath, 'utf8').split('\n').filter(Boolean).join('\n')
    : '';
  return { ...mocks, result, log };
}

test('creates a missing tag explicitly at the candidate commit', () => {
  withTempDir((directory) => {
    const { result, log, createdTagPath } = runEnsureTarget(directory);
    assert.equal(result.status, 0, result.stderr);
    assert.match(log, /release create app-v1\.2\.3 --target a{40}/);
    assert.equal(readFileSync(createdTagPath, 'utf8'), buildSha);
  });
});

test('uses --verify-tag for an existing matching annotated tag', () => {
  withTempDir((directory) => {
    const { result, log } = runEnsureTarget(
      directory,
      { MOCK_REMOTE_SHA: buildSha, MOCK_REMOTE_ANNOTATED: 'true' },
      'true',
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(log, /release create app-v1\.2\.3 --verify-tag/);
    assert.doesNotMatch(log, /--target/);
  });
});

test('refuses a mismatched remote tag before creating or clobbering a release', () => {
  withTempDir((directory) => {
    const { result, log } = runEnsureTarget(directory, {
      MOCK_REMOTE_SHA: otherSha,
      MOCK_RELEASE_EXISTS: 'true',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to replace release assets/);
    assert.equal(log, '');
  });
});

test('refuses to recreate a tag deleted after candidate resolution', () => {
  withTempDir((directory) => {
    const { result, log } = runEnsureTarget(directory, {}, 'true');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /existed before the build but is now missing/);
    assert.equal(log, '');
  });
});

test('rechecks a newly created tag before allowing subsequent asset upload', () => {
  withTempDir((directory) => {
    const { result, log } = runEnsureTarget(directory, { MOCK_CREATE_SHA: otherSha });
    assert.notEqual(result.status, 0);
    assert.match(log, /release create app-v1\.2\.3 --target a{40}/);
    assert.match(result.stderr, /no longer resolves to build commit/);
  });
});

test('the workflow resolves the tag before build and verifies it before clobber upload', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  const resolveIndex = workflow.indexOf('Resolve release tag and build commit');
  const buildIndex = workflow.indexOf('Build unsigned macOS Apple Silicon artifacts');
  const verifyIndex = workflow.indexOf('ensure-app-release-target.sh');
  const uploadIndex = workflow.indexOf('gh release upload');
  assert.ok(resolveIndex >= 0 && resolveIndex < buildIndex);
  assert.ok(verifyIndex >= 0 && verifyIndex < uploadIndex);
  assert.match(workflow, /gh release upload "\$\{release_tag\}" \"\$\{assets\[@\]\}" --clobber/);
});

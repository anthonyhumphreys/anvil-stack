import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveAppReleaseTarget({
  packageVersion,
  refName,
  refType,
  requestedTag,
  buildSha,
  existingTagCommit,
}) {
  if (!packageVersion) throw new Error('package.json version is empty.');
  if (!/^[0-9a-f]{40}$/i.test(buildSha ?? '')) {
    throw new Error('GITHUB_SHA must be a full 40-character commit SHA.');
  }

  const expectedTag = `app-v${packageVersion}`;
  if (!/^app-v[0-9A-Za-z.+-]+$/.test(expectedTag)) {
    throw new Error('package.json version cannot be used in a release tag.');
  }
  const requested = requestedTag ?? '';
  let releaseTag = requested || expectedTag;

  if (refType === 'tag') {
    if (requested && requested !== refName) {
      throw new Error(
        `Requested release tag ${requested} does not match triggering tag ${refName}.`,
      );
    }
    releaseTag = refName;
  }

  if (releaseTag !== expectedTag) {
    throw new Error(
      `Release tag ${releaseTag} does not match package.json version ${packageVersion} (${expectedTag}).`,
    );
  }

  const normalizedBuildSha = buildSha.toLowerCase();
  const normalizedTagCommit = existingTagCommit?.toLowerCase() ?? null;
  if (normalizedTagCommit && normalizedTagCommit !== normalizedBuildSha) {
    throw new Error(
      `Release tag ${releaseTag} points to ${normalizedTagCommit}, but this workflow builds ${normalizedBuildSha}. Refusing to publish artifacts under a different commit's tag.`,
    );
  }

  if (refType === 'tag' && !normalizedTagCommit) {
    throw new Error(`Triggering tag ${releaseTag} is missing from the remote repository.`);
  }

  return {
    tag: releaseTag,
    name: `Anvil ${releaseTag}`,
    tagExists: Boolean(normalizedTagCommit),
  };
}

function readRemoteTagCommit(tag) {
  const ref = `refs/tags/${tag}`;
  const peeledRef = ref + '^{}';
  const refs = execFileSync('git', ['ls-remote', 'origin', ref, peeledRef], {
    encoding: 'utf8',
  });
  let directCommit = null;
  let peeledCommit = null;

  for (const line of refs.split(/\r?\n/)) {
    const [commit, remoteRef] = line.trim().split(/\s+/, 2);
    if (remoteRef === ref) directCommit = commit;
    if (remoteRef === peeledRef) peeledCommit = commit;
  }

  return peeledCommit ?? directCommit;
}

function main() {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
  const selectedTag =
    process.env.GITHUB_REF_TYPE === 'tag'
      ? process.env.GITHUB_REF_NAME
      : (process.env.INPUT_RELEASE_TAG || `app-v${packageJson.version}`);
  const release = resolveAppReleaseTarget({
    packageVersion: packageJson.version,
    refName: process.env.GITHUB_REF_NAME,
    refType: process.env.GITHUB_REF_TYPE,
    requestedTag: process.env.INPUT_RELEASE_TAG,
    buildSha: process.env.GITHUB_SHA,
    existingTagCommit: readRemoteTagCommit(selectedTag),
  });

  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is not set.');
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `tag=${release.tag}\nname=${release.name}\ntag_exists=${release.tagExists}\n`,
  );
  console.log(
    `Release candidate ${release.tag} resolves to ${process.env.GITHUB_SHA}; existing tag: ${release.tagExists}.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

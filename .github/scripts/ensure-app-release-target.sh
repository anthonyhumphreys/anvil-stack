#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'Release target check failed: %s\n' "$1" >&2
  exit 1
}

if [[ "$#" -ne 5 ]]; then
  fail 'expected <tag> <build-sha> <tag-existed-at-resolution> <release-name> <notes-file>.'
fi

release_tag="$1"
build_sha="$2"
tag_existed="$3"
release_name="$4"
notes_file="$5"

[[ "${release_tag}" =~ ^app-v[0-9A-Za-z.+-]+$ ]] || fail 'release tag contains unsupported characters.'
[[ "${build_sha}" =~ ^[0-9a-f]{40}$ ]] || fail 'build SHA must be a full lowercase commit SHA.'
[[ "${tag_existed}" == 'true' || "${tag_existed}" == 'false' ]] || fail 'tag-existed value must be true or false.'
[[ -f "${notes_file}" ]] || fail 'release notes file is missing.'

tag_ref="refs/tags/${release_tag}"

read_remote_tag_commit() {
  local remote_refs peeled_sha direct_sha

  if ! remote_refs="$(git -C "${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}" ls-remote origin "${tag_ref}" "${tag_ref}^{}")"; then
    fail "could not read remote tag ${release_tag}."
  fi

  peeled_sha="$(awk -v ref="${tag_ref}^{}" '$2 == ref { print $1 }' <<<"${remote_refs}")"
  direct_sha="$(awk -v ref="${tag_ref}" '$2 == ref { print $1 }' <<<"${remote_refs}")"
  if [[ -n "${peeled_sha}" ]]; then
    printf '%s' "${peeled_sha}"
  else
    printf '%s' "${direct_sha}"
  fi
}

remote_tag_commit="$(read_remote_tag_commit)"
if [[ "${tag_existed}" == 'true' && -z "${remote_tag_commit}" ]]; then
  fail "tag ${release_tag} existed before the build but is now missing remotely."
fi
if [[ -n "${remote_tag_commit}" && "${remote_tag_commit}" != "${build_sha}" ]]; then
  fail "tag ${release_tag} points to ${remote_tag_commit}, but this workflow builds ${build_sha}. Refusing to replace release assets."
fi

release_exists=false
if gh release view "${release_tag}" >/dev/null 2>&1; then
  release_exists=true
fi

if [[ "${release_exists}" == 'true' && -z "${remote_tag_commit}" ]]; then
  fail "release ${release_tag} exists without a remote tag; refusing to publish assets."
fi

if [[ "${release_exists}" == 'false' ]]; then
  if [[ -z "${remote_tag_commit}" ]]; then
    create_args=("${release_tag}" --target "${build_sha}" --title "${release_name}" --notes-file "${notes_file}")
  else
    create_args=("${release_tag}" --verify-tag --title "${release_name}" --notes-file "${notes_file}")
  fi

  if ! gh release create "${create_args[@]}"; then
    gh release view "${release_tag}" >/dev/null 2>&1 || fail "could not create or find release ${release_tag}."
  fi
fi

# Recheck immediately before the workflow uploads assets. This also catches a tag
# created or moved while the release was being created.
remote_tag_commit="$(read_remote_tag_commit)"
[[ "${remote_tag_commit}" == "${build_sha}" ]] || \
  fail "tag ${release_tag} no longer resolves to build commit ${build_sha}; refusing to upload or clobber assets."

printf 'Verified release %s resolves to build commit %s.\n' "${release_tag}" "${build_sha}"

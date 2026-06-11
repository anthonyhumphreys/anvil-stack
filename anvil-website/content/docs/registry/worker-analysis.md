---
title: Worker analysis
navTitle: Worker analysis
description: What Anvil Registry static analysis detects, how name-squatting checks work, and what evidence the worker produces.
product: Anvil Registry
section: Concepts
order: 6
---

# Worker analysis

Anvil Registry queues expensive analysis outside the install request path. The worker unpacks tarballs, compares versions, and produces evidence that feeds deterministic policy decisions.

## What the worker analyses

### Manifest checks

- Package name, version, and description changes.
- `scripts` field: new or changed lifecycle scripts.
- `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies` changes.
- New dependencies added in a patch version.
- `bin`, `files`, `repository`, `license`, and `maintainer` changes.

### Install script checks

Lifecycle scripts are the most common install-time risk surface:

- `preinstall`
- `install`
- `postinstall`
- `prepare`
- `prepublish`
- `prepublishOnly`

The worker flags new or changed scripts and scans their contents for suspicious patterns.

### Code pattern checks

Static analysis of the unpacked tarball looks for:

- `child_process` usage (`exec`, `spawn`, `fork`).
- Direct `process.env` access.
- `fs` module usage in install paths.
- `http`/`https` or `fetch` calls in install paths.
- `net.connect` or `dns` lookups.
- `eval`, `Function`, or `setTimeout` with string arguments.
- `Buffer.from(base64)` decoding followed by execution.
- Shell piping (`| sh`, `| bash`).

### File tree checks

- New binary or executable files.
- Unexpected size changes.
- Minified or obfuscated files.
- Encoded blobs (base64 strings in non-binary files).
- Hidden files (dot-prefixed).
- Unusual paths (traversal attempts, temp directories).
- Credential-looking files (`.npmrc`, `.ssh`, `.aws`, `.env`).

### Name-squatting checks

The worker compares low-adoption package names against the popular package index:

- Typo variants: missing character, extra character, transposed characters.
- Hyphen and underscore swaps.
- Pluralisation differences.
- Visual similarity (homoglyphs).
- Scope confusion (`@scope/pkg` vs `@scop/pkg`).
- Ecosystem confusion (package names that mimic well-known tools).

Algorithms used: Damerau-Levenshtein distance, Jaro-Winkler similarity, token normalisation.

## Comparison strategy

By default, the worker compares the target version against the previous three versions. This surfaces:

- What changed.
- Whether the change fits the release type (patch, minor, major).
- Whether install-time behaviour changed when runtime behaviour should not have.

## Analysis output

The worker produces a structured report stored in Postgres and linked to the package decision:

- Signal list with severity.
- File references where available.
- Diff summaries against previous versions.
- Name-squatting match results.
- Provenance status.

## LLM review context

When enabled, the worker can send structured evidence to an LLM reviewer. The model output is validated against a Zod schema and stored as review context. It never overrides the deterministic policy decision.

## Cache identity

Analysis reports are cached by:

- Package name.
- Version.
- Tarball integrity or hash.
- Analysis engine version.
- Policy version.

If any of these change, the cached report is not reused. This prevents a decision for one artifact from silently applying to a different artifact.

## Limitations

- Analysis is asynchronous. The gateway may allow or quarantine a package while analysis is pending.
- Very large tarballs may hit worker timeout limits.
- Private package metadata is excluded from LLM review by default.
- The worker does not execute install scripts. Static analysis only.

## Read next

- [Policy model](/docs/registry/policy)
- [Package decisions](/docs/registry/package-decisions)
- [LLM integration](/docs/registry/llm-integration)

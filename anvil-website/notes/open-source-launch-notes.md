# Open Source Launch Notes

Anvil Registry should be easy to explain in one sentence:

> Anvil Registry is an open source npm registry gateway, paired with Anvil Node Base, that inspects dependency risk before install traffic reaches developers or CI.

## Short Post

```text
I am opening up Anvil Registry: a secure npm registry gateway plus a hardened Node devcontainer base image.

It proxies npm metadata and tarballs, rewrites tarball URLs through policy, caches analysis by immutable tarball identity, and gives reviewers clear allow, quarantine, block, and override context.

Basically: less blind npm install, more evidence before the package lands.
```

## Discord Version

```text
Anvil Registry is a dependency safety toolkit for Node projects.

The registry gateway sits in front of npm and checks package metadata, tarballs, provenance, name-squatting risk, and static analysis before installs. The Node Base image gives you safer npm defaults plus observed install reports for unknown repos.

It is open source and designed to fit normal npm/pnpm/yarn workflows.
```

## What Not To Claim

- Do not call it a replacement for npm.
- Do not imply LLM review is the enforcement authority.
- Do not claim it prevents every supply-chain attack.
- Do not invent adoption, benchmarks, or production users.

The honest pitch is stronger: Anvil Registry makes dependency install decisions inspectable, auditable, and earlier.

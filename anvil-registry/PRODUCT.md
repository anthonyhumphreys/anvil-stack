# Product

## Register

brand

## Users

Anvil serves open source-friendly developers, maintainers, security-conscious package consumers, platform teams, and infrastructure engineers who want safer npm installs without turning ordinary dependency work into a ritual sacrifice. The primary audience is developers evaluating whether Anvil is credible, understandable, and worth trying locally or in CI.

These users are likely reading the public site, docs, or repository while deciding whether Anvil fits their workflow. They need clear installation paths, plain-language security reasoning, and enough implementation detail to trust the tool without wading through vendor theatre.

## Product Purpose

Anvil Registry is an npm registry gateway that proxies package metadata and tarballs, caches artefacts, analyses package risk, and enforces deterministic dependency policy before installs reach developers or CI. Anvil Node Base is the companion devcontainer base image for safer local and agentic coding environments.

The public site should promote both tools as serious open source security infrastructure: practical, inspectable, and usable by individual developers as well as teams. Success means a visitor quickly understands the threat model, sees how to try the registry or base image, trusts the policy model, and can move from landing page to docs without friction.

## Brand Personality

Clean, technical, and OSS-native.

The voice should feel like a capable maintainer explaining a sharp tool: plain-spoken, security-aware, mildly opinionated, and allergic to decorative nonsense. It can be dry and a little wry, especially when describing npm ecosystem hazards, but it should stay serious around security, data loss, CI, and production risk.

## Anti-references

Do not make Anvil feel like glossy cybersecurity vendor sludge, generic SaaS dashboard wallpaper, hacker-terminal cosplay, or corporate DevSecOps content mulch. Avoid inflated claims, fake urgency, black-and-neon threat theatre, vague compliance language, and heroic metrics with no receipts.

The site should not look like a crypto security product, a venture-backed observability clone, or a dark terminal skin stretched over a marketing page. If the design starts yelling "enterprise-grade visibility platform", escort it outside politely.

## Design Principles

1. Lead with proof, not posture. Show concrete commands, policy decisions, install flows, artefacts, and audit trails before abstract claims.
2. Make security legible. Explain why something is blocked, quarantined, cached, or overridden in language a developer can act on.
3. Respect open source readers. Use honest scope, visible implementation detail, and documentation-forward navigation instead of conversion-funnel theatre.
4. Keep the path short. A curious developer should get from landing page to local trial, Docker Compose, CI usage, or devcontainer base image with minimal hunting.
5. Let the product have an edge. Anvil can sound opinionated about npm install risk, but the interface should stay calm, precise, and useful.

## Accessibility & Inclusion

Target WCAG 2.2 AA for public site and future product surfaces. Preserve strong contrast in light and dark themes, avoid color-only status communication, support keyboard navigation, and respect reduced-motion preferences.

Documentation and command examples should be readable on narrow screens, copyable, and understandable without relying on imagery. Security states such as allow, warn, quarantine, and block should combine text, iconography, and color so users with color-vision differences are not forced to decode vibes.

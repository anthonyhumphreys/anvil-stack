# AGENTS.md

## Scope

These instructions apply to the standalone `anvil-website` Next.js site.

The site is not nested under another repo. It is the public website for Anvil Desktop, Anvil Registry, Anvil Node Base, and Anvil Cloud.

## Product Posture

Anvil is open source developer infrastructure. Keep the site useful for developers trying to inspect, run, or contribute to the projects today.

- Be honest about alpha or early surfaces.
- Do not describe unbuilt features as production-ready.
- Do not hide sharp edges behind glossy copy.
- Avoid SaaS dashboard language, cybersecurity vendor sludge, and fake maturity.
- Lead with commands, architecture, setup paths, policy reasoning, and evidence.

## Documentation Rules

- Put documentation pages in `content/docs`.
- Use Markdown with frontmatter: `title`, `navTitle`, `description`, `product`, `section`, and `order`.
- Group docs by product folder where possible.
- Keep docs broad enough for a new OSS reader to understand the desktop app, registry gateway, Node Base, Anvil Cloud, CLI, CI, deployment, policy, reports, companion controls, extension points, and known limitations.
- Keep security claims grounded in implementation, specs, or explicit scope notes.
- Deterministic policy is the Registry enforcement authority. LLM review can explain evidence; it must not be described as what allows a package.

## Site Architecture

- App Router pages live in `app`.
- Reusable UI lives in `components`.
- Docs loading and markdown parsing live in `lib/docs.ts`.
- Shared site copy and nav data live in `lib/site.ts`.
- Static assets live in `public`.
- Docs pages are rendered by `app/docs/[...slug]/page.tsx`.

## Design And Copy

- Use the Anvil forge style: clean, technical, OSS-native, and proof-led.
- Keep the palette restrained with meaningful forge-orange accents.
- Use OKLCH tokens for colors.
- Avoid gradient text, decorative glass, side-stripe borders, hero metric templates, and identical card grids as the main answer.
- No corporate brochure language. If the sentence could appear on a venture-backed DevSecOps site, rewrite it before it starts charging a platform fee.

## Validation

Use the smallest useful validation for the change:

```bash
pnpm build
pnpm typecheck
```

For local development:

```bash
pnpm install --ignore-scripts
pnpm dev
```

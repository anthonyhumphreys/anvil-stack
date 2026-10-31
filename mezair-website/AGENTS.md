# AGENTS.md

## Scope

These instructions apply to the standalone `mezair-website` Next.js site.

The site is not nested under another repo. It is the public website for Mezair Desktop, Mezair Registry, Mezair Node Base, and Mezair Cloud.

## Product Posture

Mezair is open source developer infrastructure. Keep the site useful for developers trying to inspect, run, or contribute to the projects today.

- Be honest about alpha or early surfaces.
- Describe feature availability and limits in terms of what users can do.
- Do not hide sharp edges behind glossy copy.
- Avoid SaaS dashboard language, cybersecurity vendor sludge, and fake maturity.
- Lead with commands, architecture, setup paths, policy reasoning, and evidence.

## Documentation Rules

- Put documentation pages in `content/docs`.
- Use Markdown with frontmatter: `title`, `navTitle`, `description`, `product`, `section`, and `order`.
- Group docs by product folder where possible.
- Keep docs broad enough for a new OSS reader to understand the desktop app, registry gateway, Node Base, Mezair Cloud, CLI, CI, deployment, policy, reports, companion controls, extension points, and known limitations.
- Keep security claims grounded in implementation, specs, or explicit scope notes.
- Deterministic policy is the Registry enforcement authority. LLM review can explain evidence; it must not be described as what allows a package.

## Public And Internal Content

- Write public pages for people choosing, installing, using, deploying or extending Mezair.
- Keep internal QA reports, test counts, deployment rehearsals, physical-device acceptance plans, release gates, production provisioning checklists and implementation diaries in the owning project's repository docs, plans or runbooks. Do not publish them in `content/docs` or marketing copy.
- Keep limitations that change a user's actions: unsupported features, compatibility, data handling, configuration requirements and costs. State unavailable services plainly without listing internal launch work.
- Place configuration warnings beside the command or setting they affect. Reference links belong under related reading, not under "Current limits".
- Setup guides should offer a useful prompt users can copy into their coding agent. Use a `prompt` fenced block so it renders with a "Copy prompt" button. Include the goal, relevant public guide, necessary choices and expected result.

## Site Architecture

- App Router pages live in `app`.
- Reusable UI lives in `components`.
- Docs loading and markdown parsing live in `lib/docs.ts`.
- Shared site copy and nav data live in `lib/site.ts`.
- Static assets live in `public`.
- Docs pages are rendered by `app/docs/[...slug]/page.tsx`.

## Design And Copy

- Use the Mezair style: clean, technical, OSS-native, and proof-led.
- Keep the palette restrained with meaningful action accents.
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

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

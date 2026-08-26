# Anvil Website & Documentation Improvement Plan

## Outcome

Turn the Anvil website into a polished, proof-led public home with a documentation system that makes five things immediately clear:

1. What Anvil is.
2. How Desktop, Cloud, Registry, and Node Base differ.
3. Which product is relevant to the visitor.
4. Where the visitor is within the documentation.
5. What they should read or do next.

The default site register remains brand-led and OSS-native. The documentation area behaves like a focused product interface: fast, navigable, searchable, accessible, and optimized for repeated use.

## Confirmed direction

- Audience model: support newcomers and experienced operators through distinct **Learn**, **Build**, and **Reference** paths.
- Visual direction: retain the restrained forge-orange identity.
- Reference qualities:
  - GitHub Docs for wayfinding and task orientation.
  - Stripe Docs for hierarchy and reading ergonomics.
  - Linear for interaction restraint and fine-grained polish.
- Scope includes substantial taxonomy changes and dedicated product landing pages.
- Product truth remains more important than promotional shine.

## Evidence from the current implementation

### Existing strengths

- Clean Next.js App Router implementation with static generation.
- Markdown-first documentation and structured frontmatter.
- A restrained OKLCH token system with working light and dark modes.
- Good baseline use of semantic links, landmarks, focus styles, decorative icon hiding, and optimized images.
- Product claims generally emphasize boundaries, implementation status, and evidence.
- Current validation passes:
  - `pnpm build`
  - `pnpm typecheck`
  - `git diff --check`
- The site statically generates 74 routes.
- A local-link scan found no unresolved documentation links.

### Scale of the documentation

- 69 documentation pages.
- Approximately 9,813 lines of Markdown.
- Anvil Cloud: 21 pages.
- Anvil Registry: 20 pages.
- Anvil Desktop: 17 pages.
- Anvil Node Base: 6 pages.
- Project and shared starting material: 5 pages.

Several individual pages exceed 250–490 lines, including Cloud Agents, the Cloud CLI reference, Registry CLI, AWS preview, examples, sandboxes, and the Cloud quickstart.

### Core navigation problem

`components/site/docs-nav.tsx` technically detects the current slug and changes its background and weight. The experience still fails because:

- All products and all 69 pages are rendered in one continuous tree.
- The sidebar opens at its own scroll origin rather than the current page.
- Later products can place the active item far below the visible viewport.
- The active styling is subtle and has no forge-specific marker.
- The active link lacks `aria-current="page"`.
- Product headings and section labels are not interactive or collapsible.
- Mobile expands the same entire tree behind a generic “Browse all docs” label.
- The mobile control does not state the current product, section, or page.

This explains the reported experience: the current page is present in markup but often functionally invisible.

### Structural issues

- Navigation hierarchy is inferred from minimum page-order values, which makes frontmatter ordering fragile and encourages decimal orders.
- Taxonomies differ considerably between products:
  - Basics
  - Overview
  - Getting started
  - Concepts
  - Architecture
  - Runtime
  - Working guide
  - Engineering
  - Assurance
  - Operations
  - Deployment
  - Project
  - Notes
- Previous and next links traverse the global document list and can unexpectedly cross product boundaries.
- Breadcrumbs are plain text rather than navigable links.
- Documentation pages have no in-page table of contents.
- Markdown headings do not provide a visible deep-link interaction.
- There is no documentation search despite the content volume.
- The docs index presents four nearly identical product cards followed by a very large full index.
- The global header duplicates Docs, Cloud, Registry, Desktop, OSS, and a second “Read the docs” action without showing the active section.
- The homepage currently offers four hero actions of similar weight.
- Homepage product explanations repeat across the repository map, product section, proof section, and docs section.
- The hero omits Node Base in its product-family sentence.
- The homepage includes decorative grid treatment and wide shadow/glass combinations that conflict with the desired Impeccable direction.
- There is no skip link.
- Heading anchors lack `scroll-margin-top`.
- Mobile documentation links and the mobile menu trigger should be audited against the 44px touch-target requirement.
- The default Next.js not-found experience is not a useful recovery path for mistyped or moved documentation URLs.

## Experience architecture

### Layer 1: Global website

The global website answers:

- What is the Anvil family?
- Which surface solves my problem?
- What is usable today?
- Where is the evidence?
- Should I read, download, or inspect the repository?

Recommended global navigation:

- Products
- Docs
- GitHub
- Download Desktop

“Products” opens a concise product switcher with one-line ownership statements. Do not place every product as a separate permanent header item.

The active global destination must be visibly and semantically indicated.

### Layer 2: Documentation hub

Route: `/docs`

The documentation hub becomes a journey chooser, not a full sitemap.

Primary choices:

- **Learn Anvil** — understand the family, boundaries, and product relationships.
- **Build with Anvil** — install, configure, run, and integrate a product.
- **Use the reference** — locate commands, configuration, APIs, status, and troubleshooting.

The hub should also expose the four product landing pages and a prominent documentation search.

The exhaustive index may remain available as a secondary “View all pages” disclosure or route, but it should not dominate the main experience.

### Layer 3: Product landing pages

Add stable landing routes:

- `/docs/desktop`
- `/docs/cloud`
- `/docs/registry`
- `/docs/node-base`

Keep existing document URLs stable. Redirect only when a clearer canonical destination exists.

Each product landing page should answer:

- What does this product own?
- Who is it for?
- What can it do today?
- What remains alpha or limited?
- How do I start?
- Which repository and package own it?
- Where should I go for Learn, Build, and Reference material?

### Layer 4: Documentation reader

Desktop layout:
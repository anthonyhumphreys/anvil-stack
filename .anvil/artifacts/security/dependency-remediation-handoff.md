# Security dependency remediation

## Delivered

- Desktop:
  - Electron 39.8.10
  - React Router 7.18.2
  - DOMPurify 3.4.13
  - Mermaid 11.16.1
  - Patched transitive overrides for brace-expansion, fast-uri, js-yaml, nanoid, PostCSS, tar, undici and ws
- Website:
  - Next.js 16.3.0 with its supported Sharp 0.35 line
  - ESLint CLI migration using the official Next codemod
  - React theme store updated for the new lint rules
- Cloud:
  - Patched brace-expansion, nanoid and PostCSS
- Video:
  - All Remotion packages aligned exactly at 4.0.507
  - ws 8.21.3
- Raycast:
  - Latest compatible 1.x API/utils
  - Patched esbuild and brace-expansion overrides

## Audit results

| Surface | Result |
|---|---:|
| Website | 0 vulnerabilities |
| Cloud | 0 vulnerabilities |
| Registry | 0 vulnerabilities |
| Video | 0 vulnerabilities |
| Raycast | 0 vulnerabilities |
| Desktop | 2 high, no patched release available |

Desktop’s remaining findings are both in `image-size@1.2.1`, reached through Expo/Metro. The advisories affect every published release through the latest `2.0.2` and specify no patched version. Metro also requires the 1.x API. No unsupported override was added.

## Verification

- Desktop: lint passed; build passed; 80 test files and 458 tests passed
- Mobile: lint and typecheck passed
- Website: audit, lint, typecheck and production build passed; 73 static pages generated
- Cloud: audit, lint, build, typecheck and all workspace tests passed
- Video: audit and TypeScript checks passed
- Raycast: audit, TypeScript and production build passed
- `git diff --check` passed

Raycast’s network-backed lint validation still reports the existing author account as a 404. Compilation, TypeScript and the extension build pass.

## Key files

- [Desktop dependencies](/Users/anthonyhumphreys/Code/anvil-worktrees/security-review-2026-08-09/anvil-app/package.json:55)
- [Website dependencies](/Users/anthonyhumphreys/Code/anvil-worktrees/security-review-2026-08-09/anvil-website/package.json:19)
- [Website theme migration](/Users/anthonyhumphreys/Code/anvil-worktrees/security-review-2026-08-09/anvil-website/components/site/theme-toggle.tsx:30)
- [Cloud overrides](/Users/anthonyhumphreys/Code/anvil-worktrees/security-review-2026-08-09/anvil-cloud/package.json:36)
- [Video dependencies](/Users/anthonyhumphreys/Code/anvil-worktrees/security-review-2026-08-09/anvil-app/video/package.json:11)
- [Raycast dependencies](/Users/anthonyhumphreys/Code/anvil-worktrees/security-review-2026-08-09/anvil-app/raycast/anvil/package.json:64)

## Git state

- Branch: `codex/security-dependency-remediation`
- Based on: `origin/main` at `3121c43`
- Changes are uncommitted and have not been pushed.
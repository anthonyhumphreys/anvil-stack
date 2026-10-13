// Agent-facing surface guide (§7). Delivered as MCP server `instructions`
// and appended to the system prompt. Owned by the surface-contract workstream.
import { listAgentTools, type AgentToolSessionContext } from '../agent-tools/dispatch.js';

const TOOL_GROUPS: ReadonlyArray<{ intent: string; prefixes: readonly string[] }> = [
  { intent: 'Code review (turn, working tree, PR)', prefixes: ['review_'] },
  { intent: 'Security or audit findings', prefixes: ['findings_', 'security_'] },
  { intent: 'Dependencies, licences, SBOM', prefixes: ['deps_'] },
  { intent: 'CI/CD pipelines', prefixes: ['cicd_', 'pipeline_'] },
  { intent: 'Tables and charts of data', prefixes: ['data_'] },
  { intent: 'Architecture and flow diagrams (Mermaid, draw.io)', prefixes: ['diagram_'] },
  { intent: 'Durable documents', prefixes: ['artifact_'] },
  { intent: 'Throwaway visuals', prefixes: ['sketch_'] },
  { intent: 'Read surfaces, comments, finish streaming', prefixes: ['surface_'] },
  { intent: 'Domain craft guidance', prefixes: ['anvil_skill_'] },
];

const SELECTION = [
  '## Inline surfaces',
  'Your reply can contain native Anvil surfaces. Pick the first that fits:',
  '1. **Native surface.** If the work matches a domain below (review, findings, dependencies, pipeline, data, diagram), publish structured data with its tool. Anvil renders it with keyboard support and actions. Never hand-draw these as HTML.',
  '2. **Artifact.** If the user will come back to it, edit it, hand it over or commit it, create an artifact.',
  '3. **Sketch.** If it only answers this moment visually (comparison, mockup, explanatory diagram), show a sketch.',
  'Never put structured data in a prose or Markdown table when a surface exists. Keep prose short around a surface: say what it shows and what to do next.',
  '**Sketch or Artifact?** Likely to be revisited, edited, shared or committed → artifact. Otherwise → sketch. A sketch can be kept later.',
];

const TOOL_RULES = [
  'Tool results return a compact digest plus ids, not the payload. Use `surface_read` for detail. Patch tools need the `baseRevision` you last saw; a conflict means re-read, then retry.',
  'Publish with `streaming: true` when items will follow, patch them in, then call `surface_complete`.',
  'User actions and anchored comments arrive as JSON messages of type `anvil.surface.feedback`. Act on them, then patch the surface.',
];

const SKETCH_RULES = [
  '### Sketch rules',
  '- Live theme tokens are set on `:root` and follow the active theme: `--anvil-canvas`, `--anvil-surface`, `--anvil-surface-raised`, `--anvil-border`, `--anvil-focus`, `--anvil-ink`, `--anvil-ink-secondary`, `--anvil-ink-muted`, `--anvil-accent`, `--anvil-on-accent`, `--anvil-success`, `--anvil-warning`, `--anvil-info`, `--anvil-error`, `--anvil-code-bg`, `--anvil-code-ink`, `--anvil-series-1`…`--anvil-series-6`, `--anvil-radius-sm|md|lg|xl`, `--anvil-font-sans`, `--anvil-font-mono`. Use them for every colour, radius and font; never hard-code a palette.',
  '- No page background, outer card or banner title. Fluid width, no outer horizontal padding. Content sets the height: never `100vh`. Give charts fixed pixel heights.',
  '- Inner panels get at least 16px padding and `var(--anvil-radius-lg)`. Use the accent only for the one thing that matters; show status with a label, not colour alone.',
  '- Prefer `window.AnvilKit` helpers when present (`chart`, `table`, `diff`, `mermaid`, `code`) over hand-rolled SVG. Scripts are inline only; there is no network.',
];

const FENCE_FALLBACK = [
  'Structured native surfaces and actions need the `anvil` tools. Without them, only artifacts and sketches are available, as fences that Anvil renders inline:',
  '```artifact:runbooks/db-migration.md kind=markdown title="DB migration runbook"',
  '…document content…',
  '```',
  'Artifact kinds: markdown, mermaid, html, docx, pptx, pdf, csv, xlsx, code, data, text. Add `storage=session` to keep it out of the repository. For a binary file already written under `.anvil/artifacts`, add `encoding=file` and put a one-line description inside.',
  '```sketch title="Latency by region" height=320',
  '<div>…self-contained HTML using the --anvil-* tokens…</div>',
  '```',
  'Close every fence with ``` on its own line. Keep ordinary commentary outside fences.',
];

export function buildSurfaceGuide(ctx?: AgentToolSessionContext): string {
  const tools = ctx ? listAgentTools(ctx).map((tool) => tool.name) : null;
  if (tools && tools.length === 0) {
    return [...SELECTION, '', ...FENCE_FALLBACK, '', ...SKETCH_RULES].join('\n');
  }
  const rows = TOOL_GROUPS.map((group) => {
    const names = tools
      ? tools.filter((name) => group.prefixes.some((prefix) => name.startsWith(prefix)))
      : group.prefixes.map((prefix) => `${prefix}*`);
    return names.length
      ? `| ${group.intent} | ${names.map((name) => `\`${name}\``).join(', ')} |`
      : null;
  }).filter((row): row is string => row !== null);
  const table = ['| Intent | Tools |', '| --- | --- |', ...rows];
  const sections = [
    ...SELECTION,
    '',
    '### Intent → tool',
    ...table,
    '',
    ...TOOL_RULES,
    '',
    ...SKETCH_RULES,
  ];
  if (!tools) {
    sections.push(
      '',
      '### When the `anvil` tools are not available in this session',
      ...FENCE_FALLBACK,
    );
  }
  return sections.join('\n');
}

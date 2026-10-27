// Agent-facing surface guide (§7). Delivered as MCP server `instructions`
// and appended to the system prompt. Owned by the surface-contract workstream.
import { listAgentTools, type AgentToolSessionContext } from '../agent-tools/dispatch.js';

const TOOL_GROUPS: ReadonlyArray<{ intent: string; prefixes: readonly string[] }> = [
  { intent: 'Propose and track delegated tasks in this chat', prefixes: ['delegation_'] },
  { intent: 'Delegate tracked work across local agents, fleet and cloud', prefixes: ['workflow_'] },
  { intent: 'Ask the user a question', prefixes: ['question_'] },
  { intent: 'Code review (turn, working tree, PR)', prefixes: ['review_'] },
  { intent: 'Explicit validation against a request or work item', prefixes: ['validation_'] },
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
  'Introduce validation only when the user asks or a workflow explicitly specifies it; never suggest it automatically after edits. Use validation_context for the request and work-item criteria, then validation_publish to show an inline plan. Ask question_ask only for material ambiguity. Run saved command checks with validation_run under existing access; record browser/manual/inspection evidence with validation_record, labelled agent-reported. Use blocked or unchecked when proof is missing. Revising criteria or changing source invalidates prior evidence. Validation is separate from code review and human acceptance.',
  'For ordinary chat delegation use delegation_discover, then delegation_propose. No saved workflow is required. Honour explicit user requests. You may also propose delegation when a discovered capability, a different platform, isolation or independent review gives a concrete benefit; explain why and wait for the inline decision. Keep simple or tightly coupled work local. Never launch native subagents to bypass that review, invent a fleet destination, or claim a remote result is integrated. Use delegation_read after resuming a chat. Delegated jobs continue if the coordinator stops; cancel them explicitly when the user asks.',
  'For tracked delegation use workflow_list, workflow_start and workflow_read. Use a saved workflow’s approved specialist pool and targets. The local chat remains the coordinator. Cloud and fleet workers use pinned isolated workspaces; returned code is not integrated until the user explicitly converges it. Read failed or waiting results honestly; do not treat an agent handoff as verification.',
  'When you need the user to choose or clarify, use `question_ask`. It works across providers and modes, pauses until the user answers, and returns their answers. Ask only what you need to proceed. Do not duplicate the question in prose. If cancelled or expired, continue only where their answer is not required.',
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

// Agent-facing surface guide (§7). Delivered as MCP server `instructions`
// and appended to the system prompt. Owned by the surface-contract workstream.
import type { AgentToolSessionContext } from '../agent-tools/dispatch.js';

export function buildSurfaceGuide(_ctx?: AgentToolSessionContext): string {
  return '';
}

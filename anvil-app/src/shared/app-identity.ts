export const APP_NAME = 'Anvil';
export const PRIMARY_PROTOCOL = 'anvil';
export const LEGACY_PROTOCOL = 'devhub';

export const PRIMARY_DB_FILENAME = 'anvil.db';
export const LEGACY_DB_FILENAME = 'devhub.db';

export const PRIMARY_HIDDEN_DIR_NAME = '.anvil';
export const LEGACY_HIDDEN_DIR_NAME = '.devhub';

export const PRIMARY_BROWSER_MCP_NAME = 'anvil-chrome';
export const LEGACY_BROWSER_MCP_NAME = 'devhub-chrome';

export const PRIMARY_TERMINAL_STORAGE_KEY = 'anvil-terminal-height';
export const LEGACY_TERMINAL_STORAGE_KEY = 'devhub-terminal-height';

export const PRIMARY_CODEX_TEMP_PREFIX = 'anvil-codex-';
export const LEGACY_CODEX_TEMP_PREFIX = 'devhub-codex-';

export const PRIMARY_SCAFFOLD_COMPLETE_MARKER = 'ANVIL_SCAFFOLD_COMPLETE';
export const LEGACY_SCAFFOLD_COMPLETE_MARKER = 'DEVHUB_SCAFFOLD_COMPLETE';

export function getBrowserMcpNames(): string[] {
  return [PRIMARY_BROWSER_MCP_NAME, LEGACY_BROWSER_MCP_NAME];
}

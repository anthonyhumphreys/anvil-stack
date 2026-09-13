// Provider CLI spawn environment (SESSION-01 audit, spec §7).
//
// Interactive provider processes (codex app-server, cursor-agent acp,
// codex exec) must not inherit the full host environment — ambient
// tokens (GH_TOKEN, AWS_*, ANVIL_*, arbitrary user exports) would leak
// into agent subprocesses. The allowlist below keeps what a provider
// CLI legitimately needs:
//
//   - base session vars (PATH/HOME — codex reads ~/.codex via HOME)
//   - proxy vars (corporate egress)
//   - XDG/CODEX_HOME (provider config relocation)
//   - git transport (SSH_AUTH_SOCK, GIT_SSH*) — the local user's own
//     credentials, used intentionally for agent-driven git ops on the
//     user's device. A remote Mesh worker spawn uses a stricter env;
//     this list is for local interactive sessions only.
//   - provider credential vars — the target-local binding for the
//     provider being spawned (codex reads env_key from config.toml)
//
// Callers may pass explicit `extra` bindings for per-invocation values
// (e.g. OPENAI_API_KEY resolved from settings).

const AMBIENT_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'TERM',
  'SYSTEMROOT',
  'COMSPEC',
  'WINDIR',
  'PROGRAMDATA',
  '__CF_USER_TEXT_ENCODING',
] as const;

const NETWORK_ALLOWLIST = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
] as const;

const PROVIDER_CONFIG_ALLOWLIST = [
  'CODEX_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
] as const;

const GIT_TRANSPORT_ALLOWLIST = [
  'SSH_AUTH_SOCK',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_EDITOR',
  'GIT_CONFIG_NOSYSTEM',
] as const;

const PROVIDER_CREDENTIAL_ALLOWLIST = [
  'OPENAI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CURSOR_API_KEY',
] as const;

/**
 * Allowlisted environment for a local provider CLI spawn. Never spreads
 * `process.env`. `extra` wins over ambient values for explicit bindings.
 */
export function providerSpawnEnv(
  extra?: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [
    ...AMBIENT_ALLOWLIST,
    ...NETWORK_ALLOWLIST,
    ...PROVIDER_CONFIG_ALLOWLIST,
    ...GIT_TRANSPORT_ALLOWLIST,
    ...PROVIDER_CREDENTIAL_ALLOWLIST,
  ]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(extra ?? {})) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

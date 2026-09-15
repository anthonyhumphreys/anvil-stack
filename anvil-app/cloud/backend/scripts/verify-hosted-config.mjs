#!/usr/bin/env node
/**
 * verify-hosted-config.mjs — BILL-06 hosted deployment validation.
 *
 * Checks that wrangler.hosted.jsonc is safe to deploy to production:
 * the D1 billing store is provisioned (no placeholder database_id),
 * enforcement is on, dev-only credentials are absent, and the sync
 * surface (Durable Object bindings, DO migrations, R2 bucket) still
 * matches wrangler.jsonc. Missing billing configuration must fail
 * hosted deployment validation — this script is that gate.
 *
 * Usage:
 *   node scripts/verify-hosted-config.mjs [config-path]
 *       [--base <wrangler.jsonc path>] [--json]
 *   node scripts/verify-hosted-config.mjs --self-check [--json]
 *
 * Exit code is 1 whenever issues exist, 0 otherwise. Warnings never
 * fail the run. Secrets (HOSTED_SERVICE_KEYS, STRIPE_SECRET_KEY,
 * STRIPE_WEBHOOK_SECRET) cannot be verified from a config file — the
 * script warns unless the file at least documents them in comments.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_CONFIG = join(BACKEND_DIR, 'wrangler.hosted.jsonc');
const DEFAULT_BASE = join(BACKEND_DIR, 'wrangler.jsonc');

const FORBIDDEN_VARS = ['ANVIL_DEV_SPIKE', 'ENROLLMENT_ADMIN_TOKEN'];
const REQUIRED_SECRETS = ['HOSTED_SERVICE_KEYS', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'];

/**
 * wrangler config files are JSONC: // and /* *\/ comments plus trailing
 * commas. This strips both while staying inside string literals so
 * values like "https://…" survive. Not a general JSONC parser — scoped
 * to what wrangler configs actually contain.
 */
function jsoncToJson(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  const skipCommentsAndSpace = (j) => {
    for (;;) {
      while (j < n && /\s/.test(text[j])) j++;
      if (text[j] === '/' && text[j + 1] === '/') {
        while (j < n && text[j] !== '\n') j++;
        continue;
      }
      if (text[j] === '/' && text[j + 1] === '*') {
        j += 2;
        while (j < n && !(text[j] === '*' && text[j + 1] === '/')) j++;
        j += 2;
        continue;
      }
      return j;
    }
  };
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      out += ch;
      i++;
      while (i < n) {
        const c = text[i];
        out += c;
        i++;
        if (c === '\\' && i < n) {
          out += text[i];
          i++;
          continue;
        }
        if (c === '"') break;
      }
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === ',') {
      const j = skipCommentsAndSpace(i + 1);
      if (text[j] === '}' || text[j] === ']') {
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/** Recursively sort object keys so deep-equal ignores key order. */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function bindingsByName(list, nameKey, classKey) {
  const map = new Map();
  for (const entry of Array.isArray(list) ? list : []) {
    if (entry && typeof entry === 'object') map.set(String(entry[nameKey]), entry[classKey]);
  }
  return map;
}

/**
 * Validate a parsed hosted config against the parsed base config.
 * `rawHostedText` is the unstripped file contents, used to confirm the
 * required-secrets checklist is at least documented in comments.
 * Returns { issues: string[], warnings: string[] }.
 */
function validateHostedConfig(hosted, base, rawHostedText = '') {
  const issues = [];
  const warnings = [];

  // --- D1 billing store -------------------------------------------------
  const d1 = Array.isArray(hosted.d1_databases) ? hosted.d1_databases : [];
  const hostedDb = d1.find((d) => d && typeof d === 'object' && d.binding === 'HOSTED_DB');
  if (!hostedDb) {
    issues.push(
      'd1_databases has no binding named HOSTED_DB — the hosted billing store is required',
    );
  } else {
    const id = hostedDb.database_id;
    if (typeof id !== 'string' || id.length === 0) {
      issues.push(
        'd1_databases[HOSTED_DB].database_id is missing or empty — run ' +
          '`wrangler d1 create anvil-hosted-billing` and record the real id',
      );
    } else if (/placeholder/i.test(id)) {
      issues.push(
        `d1_databases[HOSTED_DB].database_id is still a placeholder ("${id}") — ` +
          'provision D1 before deploying',
      );
    }
    if (typeof hostedDb.database_name !== 'string' || hostedDb.database_name.length === 0) {
      issues.push('d1_databases[HOSTED_DB].database_name is missing or empty');
    }
  }

  // --- vars ---------------------------------------------------------------
  const vars =
    hosted.vars !== null && typeof hosted.vars === 'object' && !Array.isArray(hosted.vars)
      ? hosted.vars
      : {};
  if (vars.HOSTED_BILLING_ENFORCEMENT !== 'true') {
    issues.push(
      "vars.HOSTED_BILLING_ENFORCEMENT must be the literal string 'true' on a hosted " +
        'production deployment — anything else leaves mutating operations ungated',
    );
  }
  for (const key of FORBIDDEN_VARS) {
    if (Object.hasOwn(vars, key)) {
      issues.push(
        `vars.${key} must not appear in hosted production config — it is a dev-only ` +
          'credential and must live in secrets or be omitted entirely',
      );
    }
  }

  // --- sync-surface parity with wrangler.jsonc ----------------------------
  if (base !== null && typeof base === 'object') {
    const hostedDo = bindingsByName(hosted.durable_objects?.bindings, 'name', 'class_name');
    const baseDo = bindingsByName(base.durable_objects?.bindings, 'name', 'class_name');
    for (const [name, className] of baseDo) {
      if (!hostedDo.has(name)) {
        issues.push(
          `durable_objects.bindings is missing ${name} (${className}) — hosted deploy ` +
            'must keep the full sync surface from wrangler.jsonc',
        );
      } else if (hostedDo.get(name) !== className) {
        issues.push(
          `durable_objects.bindings[${name}] maps to ${hostedDo.get(name)} but ` +
            `wrangler.jsonc maps it to ${className}`,
        );
      }
    }
    for (const name of hostedDo.keys()) {
      if (!baseDo.has(name)) {
        warnings.push(
          `durable_objects.bindings has extra binding ${name} not present in wrangler.jsonc`,
        );
      }
    }

    if (stableStringify(hosted.migrations) !== stableStringify(base.migrations)) {
      issues.push(
        'migrations (Durable Object history) differs from wrangler.jsonc — the hosted ' +
          'worker must carry identical DO migrations or existing objects break',
      );
    }

    const hostedR2 = bindingsByName(hosted.r2_buckets, 'binding', 'bucket_name');
    const baseR2 = bindingsByName(base.r2_buckets, 'binding', 'bucket_name');
    for (const [binding, bucket] of baseR2) {
      if (!hostedR2.has(binding)) {
        issues.push(
          `r2_buckets is missing binding ${binding} (${bucket}) — hosted deploy must ` +
            'keep the artifact store from wrangler.jsonc',
        );
      } else if (hostedR2.get(binding) !== bucket) {
        issues.push(
          `r2_buckets[${binding}] points at "${hostedR2.get(binding)}" but ` +
            `wrangler.jsonc uses "${bucket}"`,
        );
      }
    }
  }

  // --- required secrets checklist (documented in comments only) -----------
  for (const name of REQUIRED_SECRETS) {
    if (!rawHostedText.includes(name)) {
      warnings.push(
        `${name} is not mentioned anywhere in the config — secrets cannot be verified ` +
          'from this file, but the hosted config should document them as a ' +
          '`wrangler secret put` checklist in comments',
      );
    }
  }

  return { issues, warnings };
}

function loadJsonc(path) {
  const raw = readFileSync(path, 'utf8');
  try {
    return { config: JSON.parse(jsoncToJson(raw)), raw };
  } catch (error) {
    return { config: null, raw, parseError: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// Self-check fixtures. The good fixture mirrors a fully provisioned hosted
// config; the bad fixture reproduces the pre-launch state plus a dev-only var.
// ---------------------------------------------------------------------------
const FIXTURE_BASE = `{
  "name": "anvil-backend-spike",
  "durable_objects": {
    "bindings": [
      { "name": "ACCOUNT", "class_name": "AccountCoordinator" },
      { "name": "SESSIONS", "class_name": "SessionCoordinator" },
    ],
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["AccountCoordinator"] },
    { "tag": "v2", "new_sqlite_classes": ["SessionCoordinator"] },
  ],
  "r2_buckets": [{ "binding": "ARTIFACTS", "bucket_name": "anvil-spike-artifacts" }],
}`;

const FIXTURE_GOOD = `{
  "name": "anvil-backend-hosted",
  // Secrets via wrangler secret put, never vars:
  //   HOSTED_SERVICE_KEYS     website -> backend HMAC map
  //   STRIPE_SECRET_KEY       Stripe secret key
  //   STRIPE_WEBHOOK_SECRET   endpoint secret for /v1/hosted/stripe-webhook
  "durable_objects": {
    "bindings": [
      { "name": "ACCOUNT", "class_name": "AccountCoordinator" },
      { "name": "SESSIONS", "class_name": "SessionCoordinator" },
    ],
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["AccountCoordinator"] },
    { "tag": "v2", "new_sqlite_classes": ["SessionCoordinator"] },
  ],
  "r2_buckets": [{ "binding": "ARTIFACTS", "bucket_name": "anvil-spike-artifacts" }],
  "d1_databases": [
    {
      "binding": "HOSTED_DB",
      "database_name": "anvil-hosted-billing",
      "database_id": "5f4d2c1b-9a8e-4f7d-b6c5-3a2e1d0c9b8a",
      "migrations_dir": "migrations/hosted-billing",
    },
  ],
  "vars": {
    "HOSTED_BILLING_ENFORCEMENT": "true",
    "HOSTED_CHECKOUT_ENABLED": "true",
    "HOSTED_CHECKOUT_SUCCESS_URL": "https://anvil.example/account/billing?checkout=success",
    "STRIPE_PRICE_SYNC_MONTHLY": "price_1ExampleMonthly",
  },
}`;

const FIXTURE_BAD = `{
  "name": "anvil-backend-hosted",
  "durable_objects": {
    "bindings": [{ "name": "ACCOUNT", "class_name": "AccountCoordinator" }],
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["AccountCoordinator"] },
  ],
  "r2_buckets": [{ "binding": "ARTIFACTS", "bucket_name": "anvil-spike-artifacts" }],
  "d1_databases": [
    {
      "binding": "HOSTED_DB",
      "database_name": "anvil-hosted-billing",
      "database_id": "<placeholder-not-created>",
    },
  ],
  "vars": {
    "HOSTED_BILLING_ENFORCEMENT": "false",
    "ANVIL_DEV_SPIKE": "true",
  },
}`;

function runSelfCheck() {
  const base = JSON.parse(jsoncToJson(FIXTURE_BASE));
  const issues = [];
  const warnings = [];

  const good = validateHostedConfig(JSON.parse(jsoncToJson(FIXTURE_GOOD)), base, FIXTURE_GOOD);
  if (good.issues.length > 0) {
    issues.push(`self-check: known-good fixture produced issues: ${good.issues.join('; ')}`);
  }
  if (good.warnings.length > 0) {
    issues.push(`self-check: known-good fixture produced warnings: ${good.warnings.join('; ')}`);
  }

  const bad = validateHostedConfig(JSON.parse(jsoncToJson(FIXTURE_BAD)), base, FIXTURE_BAD);
  if (bad.issues.length === 0) {
    issues.push('self-check: broken fixture produced no issues — validator is not detecting failures');
  }
  for (const expected of [
    'placeholder',
    'HOSTED_BILLING_ENFORCEMENT',
    'ANVIL_DEV_SPIKE',
    'migrations',
    'SESSIONS',
  ]) {
    if (!bad.issues.some((issue) => issue.includes(expected))) {
      warnings.push(`self-check: broken fixture did not produce an issue mentioning "${expected}"`);
    }
  }

  return { issues, warnings };
}

function parseArgs(argv) {
  const args = { configPath: null, basePath: DEFAULT_BASE, json: false, selfCheck: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--self-check') args.selfCheck = true;
    else if (arg === '--base') {
      args.basePath = argv[++i];
      if (args.basePath === undefined) {
        process.stderr.write('verify-hosted-config: --base requires a path argument\n');
        process.exit(2);
      }
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: node scripts/verify-hosted-config.mjs [config-path] [--base <path>] ' +
          '[--json] [--self-check]\n',
      );
      process.exit(0);
    } else if (arg.startsWith('-')) {
      process.stderr.write(`verify-hosted-config: unknown flag ${arg}\n`);
      process.exit(2);
    } else if (args.configPath === null) {
      args.configPath = arg;
    } else {
      process.stderr.write(`verify-hosted-config: unexpected argument ${arg}\n`);
      process.exit(2);
    }
  }
  return args;
}

function report({ label, issues, warnings, json }) {
  const ok = issues.length === 0;
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok, issues, warnings })}\n`);
  } else {
    process.stdout.write(`verify-hosted-config: ${label}\n`);
    for (const issue of issues) process.stdout.write(`ISSUE   ${issue}\n`);
    for (const warning of warnings) process.stdout.write(`WARNING ${warning}\n`);
    process.stdout.write(
      ok
        ? `OK: 0 issues, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}\n`
        : `FAIL: ${issues.length} issue${issues.length === 1 ? '' : 's'}, ` +
            `${warnings.length} warning${warnings.length === 1 ? '' : 's'}\n`,
    );
  }
  return ok ? 0 : 1;
}

const args = parseArgs(process.argv.slice(2));

if (args.selfCheck) {
  const { issues, warnings } = runSelfCheck();
  process.exit(
    report({ label: 'self-check (inline fixtures)', issues, warnings, json: args.json }),
  );
}

const configPath = resolve(args.configPath ?? DEFAULT_CONFIG);
const basePath = resolve(args.basePath);

const hosted = loadJsonc(configPath);
if (hosted.config === null) {
  process.exit(
    report({
      label: configPath,
      issues: [`${configPath}: failed to parse as JSONC — ${hosted.parseError}`],
      warnings: [],
      json: args.json,
    }),
  );
}

const base = loadJsonc(basePath);
const baseIssues = [];
if (base.config === null) {
  baseIssues.push(
    `${basePath}: failed to parse as JSONC — ${base.parseError} (parity checks skipped)`,
  );
}

const { issues, warnings } =
  base.config === null
    ? { issues: baseIssues, warnings: [] }
    : validateHostedConfig(hosted.config, base.config, hosted.raw);

process.exit(report({ label: configPath, issues, warnings, json: args.json }));

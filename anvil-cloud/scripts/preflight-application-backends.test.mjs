import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseArgs,
  preflightCloudflare,
  runWranglerWhoami,
} from "./preflight-application-backends.mjs";

const accounts = [
  { id: "11111111111111111111111111111111", name: "First account" },
  { id: "22222222222222222222222222222222", name: "Second account" },
];

function whoamiResponse(availableAccounts = accounts, overrides = {}) {
  return JSON.stringify({
    loggedIn: true,
    authType: "oauth",
    email: "private-user@example.invalid",
    accounts: availableAccounts,
    ...overrides,
  });
}

test("selects the only accessible account without exposing user identity", async () => {
  const result = await preflightCloudflare({
    runWhoami: async () => whoamiResponse([accounts[0]]),
  });

  assert.deepEqual(result, {
    ok: true,
    method: "Cloudflare Wrangler whoami --json",
    summary:
      "Wrangler confirmed identity and access to Cloudflare account 11111111111111111111111111111111. This confirms identity only; it does not test resource permissions or live backend acceptance.",
    accountRef: "11111111111111111111111111111111",
  });
  assert.doesNotMatch(JSON.stringify(result), /private-user|email|oauth/i);
});

test("requires explicit selection when multiple accounts are accessible", async () => {
  const result = await preflightCloudflare({
    runWhoami: async () => whoamiResponse(),
  });

  assert.equal(result.ok, false);
  assert.match(result.summary, /2 Cloudflare accounts/);
  assert.match(result.summary, /--account <account-id>/);
  assert.doesNotMatch(JSON.stringify(result), /111111|222222|private-user/);
});

test("selects an explicitly requested account id from multiple accounts", async () => {
  const result = await preflightCloudflare({
    accountId: accounts[1].id,
    runWhoami: async () => whoamiResponse(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.accountRef, accounts[1].id);
});

test("allows an explicit unique account name and returns only its id", async () => {
  const result = await preflightCloudflare({
    accountId: accounts[0].name,
    runWhoami: async () => whoamiResponse(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.accountRef, accounts[0].id);
  assert.doesNotMatch(JSON.stringify(result), /First account/);
});

test("blocks an inaccessible or ambiguous explicit account", async () => {
  const inaccessible = await preflightCloudflare({
    accountId: "33333333333333333333333333333333",
    runWhoami: async () => whoamiResponse(),
  });
  const ambiguous = await preflightCloudflare({
    accountId: "Shared account",
    runWhoami: async () =>
      whoamiResponse([
        { id: "11111111111111111111111111111111", name: "Shared account" },
        { id: "22222222222222222222222222222222", name: "Shared account" },
      ]),
  });

  assert.equal(inaccessible.ok, false);
  assert.match(
    inaccessible.summary,
    /not in Wrangler's accessible account list/,
  );
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.summary, /account name is ambiguous/);
  assert.doesNotMatch(
    `${JSON.stringify(inaccessible)}${JSON.stringify(ambiguous)}`,
    /333333|Shared account|private-user/,
  );
});

test("does not auto-select when account membership data is malformed", async () => {
  const result = await preflightCloudflare({
    runWhoami: async () =>
      whoamiResponse([accounts[0], { name: "Unusable account entry" }]),
  });

  assert.equal(result.ok, false);
  assert.match(result.summary, /malformed account membership data/);
  assert.doesNotMatch(
    JSON.stringify(result),
    /Unusable account entry|private-user/,
  );
});

test("does not surface CLI errors, email, or malformed whoami output", async () => {
  const commandFailure = await preflightCloudflare({
    runWhoami: async () => {
      throw new Error("token=secret private-user@example.invalid");
    },
  });
  const malformed = await preflightCloudflare({
    runWhoami: async () => "not-json",
  });

  assert.equal(commandFailure.ok, false);
  assert.equal(malformed.ok, false);
  assert.doesNotMatch(
    `${JSON.stringify(commandFailure)}${JSON.stringify(malformed)}`,
    /secret|private-user|token=/i,
  );
});

test("invokes the Cloud workspace's Wrangler whoami JSON command", async () => {
  let invocation;
  const result = await runWranglerWhoami(async (command, args, options) => {
    invocation = { command, args, options };
    return "{}";
  });

  assert.equal(result, "{}");
  assert.equal(invocation.command, process.execPath);
  assert.match(
    invocation.args[0],
    /\/anvil-cloud\/node_modules\/wrangler\/bin\/wrangler\.js$/,
  );
  assert.deepEqual(invocation.args.slice(1), ["whoami", "--json"]);
  assert.match(invocation.options.cwd, /\/anvil-cloud$/);
  assert.equal(invocation.options.timeoutMs, 10_000);
  assert.equal(invocation.options.maxOutputBytes, 1024 * 1024);
});

test("parses provider and optional account selection", () => {
  assert.deepEqual(
    parseArgs(["--provider", "cloudflare", "--account", accounts[0].id]),
    { provider: "cloudflare", accountId: accounts[0].id },
  );
  assert.deepEqual(parseArgs(["--", "--provider", "cloudflare"]), {
    provider: "cloudflare",
    accountId: undefined,
  });
  assert.deepEqual(parseArgs(["--provider=aws"]), {
    provider: "aws",
    accountId: undefined,
  });
  assert.throws(() => parseArgs(["--provider", "aws", "--account", "id"]));
  assert.throws(() => parseArgs(["--provider", "cloudflare", "--account"]));
});

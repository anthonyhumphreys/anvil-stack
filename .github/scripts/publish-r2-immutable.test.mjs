import assert from "node:assert/strict";
import test from "node:test";
import { publishR2ImmutableObject } from "./publish-r2-immutable.mjs";

const sha256 = "a".repeat(64);
const options = {
  bucket: "anvil-desktop-releases",
  cacheControl: "public, max-age=31536000, immutable",
  contentDisposition: 'attachment; filename="Anvil-1.2.3-arm64.dmg"',
  contentType: "application/x-apple-diskimage",
  endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
  file: "/tmp/Anvil-1.2.3-arm64.dmg",
  key: "macos/arm64/releases/1.2.3/Anvil-1.2.3-arm64.dmg",
};

test("creates a versioned object with an atomic no-overwrite condition", async () => {
  const calls = [];
  const result = await publishR2ImmutableObject(options, {
    hashFile: async () => sha256,
    runAws: async (args) => {
      calls.push(args);
      return { code: 0, stderr: "", stdout: "{}" };
    },
  });

  assert.equal(result, "created");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("--if-none-match"));
  assert.ok(calls[0].includes("*"));
  assert.ok(calls[0].includes(`sha256=${sha256}`));
});

test("accepts an existing object only when its recorded digest matches", async () => {
  const results = [
    { code: 1, stderr: "PreconditionFailed", stdout: "" },
    { code: 0, stderr: "", stdout: `${sha256}\n` },
  ];
  const result = await publishR2ImmutableObject(options, {
    hashFile: async () => sha256,
    runAws: async () => results.shift(),
  });

  assert.equal(result, "unchanged");
});

test("rejects an existing object with different bytes", async () => {
  const results = [
    { code: 1, stderr: "PreconditionFailed", stdout: "" },
    { code: 0, stderr: "", stdout: `${"b".repeat(64)}\n` },
  ];
  await assert.rejects(
    publishR2ImmutableObject(options, {
      hashFile: async () => sha256,
      runAws: async () => results.shift(),
    }),
    /Refusing to replace immutable R2 object/,
  );
});

test("fails closed when object state cannot be read after a failed write", async () => {
  const results = [
    { code: 1, stderr: "network error", stdout: "" },
    { code: 1, stderr: "authentication failed", stdout: "" },
  ];
  await assert.rejects(
    publishR2ImmutableObject(options, {
      hashFile: async () => sha256,
      runAws: async () => results.shift(),
    }),
    /authentication failed/,
  );
});

test("recovers a partial publication by keeping a matching object and creating the missing one", async () => {
  const existingResults = [
    { code: 1, stderr: "PreconditionFailed", stdout: "" },
    { code: 0, stderr: "", stdout: `${sha256}\n` },
  ];
  const existing = await publishR2ImmutableObject(options, {
    hashFile: async () => sha256,
    runAws: async () => existingResults.shift(),
  });
  const created = await publishR2ImmutableObject(
    { ...options, key: options.key.replace(".dmg", "-mac.zip") },
    {
      hashFile: async () => sha256,
      runAws: async () => ({ code: 0, stderr: "", stdout: "{}" }),
    },
  );

  assert.deepEqual([existing, created], ["unchanged", "created"]);
});

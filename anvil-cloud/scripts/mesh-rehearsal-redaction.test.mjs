import assert from "node:assert/strict";
import test from "node:test";

import { redactRehearsalEvidence } from "./mesh-rehearsal-redaction.mjs";

test("redacts credential-shaped keys at any depth", () => {
  const input = {
    name: "push",
    ok: true,
    detail: {
      session: { accessToken: "anvil_at_secret", adminToken: "top" },
      nested: [{ enrollmentCode: "abc", code: "c-1" }],
    },
  };
  assert.deepEqual(redactRehearsalEvidence(input), {
    name: "push",
    ok: true,
    detail: {
      session: { accessToken: "[REDACTED]", adminToken: "[REDACTED]" },
      nested: [{ enrollmentCode: "[REDACTED]", code: "[REDACTED]" }],
    },
  });
});

test("removes token strings embedded in free text", () => {
  assert.equal(
    redactRehearsalEvidence(
      "token anvil_at_abc-123_XYZ and anvil_rt_zzz plus anvil-ec-prod-9",
    ),
    "token [REDACTED] and [REDACTED] plus [REDACTED]",
  );
});

test("does not mutate the original value", () => {
  const detail = { accessToken: "anvil_at_x", list: ["anvil-ec-q"] };
  const snapshot = JSON.parse(JSON.stringify(detail));
  redactRehearsalEvidence(detail);
  assert.deepEqual(detail, snapshot);
});

test("leaves names, ok flags, and timestamps unchanged", () => {
  const input = {
    name: "conformance",
    ok: false,
    recordedAt: "2026-09-11T00:00:00.000Z",
    count: 3,
    missing: null,
  };
  assert.deepEqual(redactRehearsalEvidence(input), input);
});

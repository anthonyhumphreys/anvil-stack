import { describe, expect, it } from "vitest";
import { normaliseRuntimeError, RuntimeError } from "../src/errors.js";

describe("normaliseRuntimeError", () => {
  it("preserves the identity of a native RuntimeError", () => {
    const error = new RuntimeError("CONFLICT", "The record changed.", 409);

    expect(normaliseRuntimeError(error)).toBe(error);
  });

  it("recognises a valid RuntimeError from another bundled copy", () => {
    const error = Object.assign(new Error("The batch was not found."), {
      name: "RuntimeError",
      code: "NOT_FOUND",
      status: 404,
      details: { providerMessage: "must not be exposed" },
    });

    const normalised = normaliseRuntimeError(error);

    expect(normalised).toBeInstanceOf(RuntimeError);
    expect(normalised.toPayload()).toEqual({
      code: "NOT_FOUND",
      message: "The batch was not found.",
    });
    expect(normalised.status).toBe(404);
  });

  it.each([
    Object.assign(new Error("unexpected provider failure"), {
      name: "RuntimeError",
      code: "PROVIDER_SECRET",
      status: 503,
    }),
    Object.assign(new Error("invalid status"), {
      name: "RuntimeError",
      code: "NOT_FOUND",
      status: 700,
    }),
    Object.assign(new Error("invalid status"), {
      name: "RuntimeError",
      code: "NOT_FOUND",
      status: 200,
    }),
    Object.assign(new Error(""), {
      name: "RuntimeError",
      code: "NOT_FOUND",
      status: 404,
    }),
  ])("keeps malformed foreign errors on the generic fallback path", (error) => {
    const normalised = normaliseRuntimeError(error);

    expect(normalised.toPayload()).toEqual({
      code: "INTERNAL_ERROR",
      message: "Handler failed during runtime execution.",
    });
    expect(normalised.status).toBe(500);
  });
});

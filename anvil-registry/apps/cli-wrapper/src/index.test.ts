import { describe, expect, it, vi } from "vitest";

import { run, type WrapperDependencies } from "./index.js";

describe("anvil wrapper cli", () => {
  it("prints wrapper usage", async () => {
    const writes: string[] = [];
    const exitCode = await run(["help"], fakeDependencies({ stdout: writes }));

    expect(exitCode).toBe(0);
    expect(writes.join("")).toContain("anvil cloud <command>");
    expect(writes.join("")).toContain("anvil registry <command>");
  });

  it("dispatches cloud commands", async () => {
    const spawnProduct = vi.fn(async () => 0);
    const exitCode = await run(["cloud", "check", "--json"], fakeDependencies({ spawnProduct }));

    expect(exitCode).toBe(0);
    expect(spawnProduct).toHaveBeenCalledWith("cloud", ["check", "--json"]);
  });

  it("dispatches registry commands", async () => {
    const spawnProduct = vi.fn(async () => 0);
    const exitCode = await run(["registry", "scan", "package-lock.json"], fakeDependencies({ spawnProduct }));

    expect(exitCode).toBe(0);
    expect(spawnProduct).toHaveBeenCalledWith("registry", ["scan", "package-lock.json"]);
  });

  it("keeps legacy registry commands working with a warning", async () => {
    const errors: string[] = [];
    const spawnProduct = vi.fn(async () => 0);
    const exitCode = await run(["scan", "package-lock.json"], fakeDependencies({ stderr: errors, spawnProduct }));

    expect(exitCode).toBe(0);
    expect(spawnProduct).toHaveBeenCalledWith("registry", ["scan", "package-lock.json"]);
    expect(errors.join("")).toContain("Deprecated");
  });

  it("fails unknown commands", async () => {
    const errors: string[] = [];
    const writes: string[] = [];
    const spawnProduct = vi.fn(async () => 0);
    const exitCode = await run(["desktop"], fakeDependencies({ stdout: writes, stderr: errors, spawnProduct }));

    expect(exitCode).toBe(1);
    expect(spawnProduct).not.toHaveBeenCalled();
    expect(errors.join("")).toContain("Unknown Anvil product or command");
    expect(writes.join("")).toContain("anvil cloud <command>");
  });
});

function fakeDependencies(
  overrides: {
    stdout?: string[];
    stderr?: string[];
    spawnProduct?: WrapperDependencies["spawnProduct"];
  } = {},
): WrapperDependencies {
  return {
    stdout: {
      write: (value: string) => {
        overrides.stdout?.push(value);
        return true;
      },
    },
    stderr: {
      write: (value: string) => {
        overrides.stderr?.push(value);
        return true;
      },
    },
    spawnProduct: overrides.spawnProduct ?? (async () => 0),
  };
}

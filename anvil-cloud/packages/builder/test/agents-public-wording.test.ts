import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(process.cwd(), "../..");
const docsRoot = path.join(repoRoot, "docs");
const publicAgentPaths = [
  path.join(docsRoot, "architecture/agents.md"),
  path.join(docsRoot, "examples/agents"),
];
const disallowedComparisonPhrases = [
  "inspired by",
  "like ",
  "unlike ",
  "alternative to",
  "similar to",
  "but cloud agnostic",
];

describe("Anvil Agents public wording", () => {
  it("avoids comparison-based positioning in new docs and examples", async () => {
    const files = await collectTextFiles(publicAgentPaths);
    const violations: Array<{ file: string; phrase: string }> = [];

    for (const file of files) {
      const text = (await readFile(file, "utf8")).toLowerCase();

      for (const phrase of disallowedComparisonPhrases) {
        if (text.includes(phrase)) {
          violations.push({
            file: path.relative(process.cwd(), file),
            phrase,
          });
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

async function collectTextFiles(entries: string[]): Promise<string[]> {
  const files: string[] = [];

  for (const entry of entries) {
    const entryStat = await stat(entry);

    if (entryStat.isFile()) {
      files.push(entry);
      continue;
    }

    const children = await readdir(entry, { withFileTypes: true });

    for (const child of children) {
      const childPath = path.join(entry, child.name);

      if (child.isDirectory()) {
        files.push(...(await collectTextFiles([childPath])));
      } else if (/\.(md|ts|tsx)$/.test(child.name)) {
        files.push(childPath);
      }
    }
  }

  return files;
}

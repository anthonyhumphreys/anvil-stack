import fs from "node:fs/promises";
import path from "node:path";
import { load as loadYaml } from "js-yaml";

const root = path.join(process.cwd(), "content", "docs");
const products = new Set(["Start here", "Anvil Desktop", "Anvil Cloud", "Anvil Registry", "Anvil Node Base", "Project"]);
const journeys = new Set(["learn", "build", "reference"]);
const required = ["title", "navTitle", "description", "product", "section", "journey", "order"];

async function markdownFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(target) : entry.name.endsWith(".md") ? [target] : [];
  }))).flat();
}

function parse(file, source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) throw new Error(`${file}: missing frontmatter`);
  const data = loadYaml(match[1]);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${file}: invalid frontmatter`);
  return { data, body: source.slice(match[0].length) };
}

const files = await markdownFiles(root);
const slugs = new Set(files.map((file) => path.relative(root, file).replace(/\.md$/, "").split(path.sep).join("/")));
const errors = [];

for (const file of files) {
  const relative = path.relative(process.cwd(), file);
  try {
    const { data, body } = parse(relative, await fs.readFile(file, "utf8"));
    for (const key of required) if (data[key] === undefined || data[key] === "") errors.push(`${relative}: missing ${key}`);
    if (!products.has(data.product)) errors.push(`${relative}: unknown product ${String(data.product)}`);
    if (!journeys.has(data.journey)) errors.push(`${relative}: journey must be learn, build, or reference`);
    if (!Number.isInteger(data.order)) errors.push(`${relative}: order must be an integer`);

    for (const match of body.matchAll(/\]\((\/docs\/[^)#?]+)(?:[?#][^)]*)?\)/g)) {
      const target = match[1].replace(/^\/docs\//, "").replace(/\/$/, "");
      if (target && !slugs.has(target)) errors.push(`${relative}: broken docs link ${match[1]}`);
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(`Validated ${files.length} documentation pages.`);

import fs from "node:fs/promises";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import { marked, Renderer } from "marked";
import {
  docsJourneys,
  docsProducts,
  resolveJourneyId,
  resolveProductId,
  type JourneyId,
  type ProductId
} from "@/lib/docs-navigation";

const docsDirectory = path.join(process.cwd(), "content", "docs");
const productOrder = new Map(docsProducts.map((product, index) => [product.id, index]));
const journeyOrder = new Map(docsJourneys.map((journey, index) => [journey.id, index]));

export type DocMeta = {
  title: string;
  navTitle: string;
  description: string;
  product: string;
  productId: ProductId;
  section: string;
  journey: JourneyId;
  order: number;
  kind: "article" | "product";
  searchHeadings: string[];
};

export type DocHeading = {
  depth: 2 | 3;
  id: string;
  text: string;
};

export type DocSearchItem = {
  slug: string;
  title: string;
  navTitle: string;
  description: string;
  product: string;
  productId: ProductId;
  section: string;
  journey: JourneyId;
  searchHeadings: string[];
  kind: "article" | "product";
};

export type DocPage = DocMeta & {
  slug: string;
  segments: string[];
  contentHtml: string;
  headings: DocHeading[];
};

marked.use({
  gfm: true,
  breaks: false
});

type FrontmatterData = Record<string, unknown>;

function parseFrontmatter(source: string): { content: string; data: FrontmatterData } {
  if (!source.startsWith("---\n")) {
    return { content: source, data: {} };
  }

  const endIndex = source.indexOf("\n---", 4);
  if (endIndex === -1) {
    return { content: source, data: {} };
  }

  const frontmatter = source.slice(4, endIndex);
  const contentStart =
    source[endIndex + 4] === "\r" && source[endIndex + 5] === "\n"
      ? endIndex + 6
      : endIndex + 5;
  const data = loadYaml(frontmatter);
  return {
    content: source.slice(contentStart),
    data: data && typeof data === "object" && !Array.isArray(data) ? (data as FrontmatterData) : {}
  };
}

async function getMarkdownFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return getMarkdownFiles(fullPath);
      return entry.isFile() && entry.name.endsWith(".md") ? [fullPath] : [];
    })
  );
  return files.flat();
}

function slugFromPath(filePath: string) {
  return path.relative(docsDirectory, filePath).replace(/\.md$/, "").split(path.sep).join("/");
}

function stripMarkdown(value: string) {
  return value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
    .replace(/[!*_~]/g, "")
    .trim();
}

function createSlugger() {
  const seen = new Map<string, number>();
  return (value: string) => {
    const base = stripMarkdown(value)
      .toLowerCase()
      .replace(/&[a-z]+;/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "section";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count + 1}`;
  };
}

function readHeadings(content: string): DocHeading[] {
  const slug = createSlugger();
  return [...content.matchAll(/^(#{2,3})\s+(.+)$/gm)].map((match) => ({
    depth: match[1].length as 2 | 3,
    id: slug(match[2]),
    text: stripMarkdown(match[2])
  }));
}

async function renderMarkdown(content: string) {
  const slug = createSlugger();
  const renderer = new Renderer();
  renderer.heading = function ({ tokens, depth }) {
    const html = this.parser.parseInline(tokens);
    const text = tokens.map((token) => "text" in token ? String(token.text) : "").join("");
    const id = slug(text || html);
    return `<h${depth} id="${id}" class="group/doc-heading"><a class="doc-heading-anchor" href="#${id}" aria-label="Link to ${stripMarkdown(text || html)}">${html}<span aria-hidden="true">#</span></a></h${depth}>`;
  };
  return marked.parse(content, { renderer });
}

function readMeta(slug: string, data: FrontmatterData): DocMeta & { slug: string; segments: string[] } {
  const segments = slug.split("/");
  const title = String(data.title ?? segments.at(-1) ?? slug);
  const product = String(data.product ?? segments[0] ?? "Project");
  const section = String(data.section ?? "Guides");
  return {
    slug,
    segments,
    title,
    navTitle: String(data.navTitle ?? title),
    description: String(data.description ?? ""),
    product,
    productId: resolveProductId(product, segments),
    section,
    journey: resolveJourneyId(data.journey, section, slug),
    order: Number(data.order ?? 999),
    kind: data.kind === "product" ? "product" : "article",
    searchHeadings: []
  };
}

export async function getDocs(): Promise<Array<DocMeta & { slug: string; segments: string[] }>> {
  const files = await getMarkdownFiles(docsDirectory);
  const docs = await Promise.all(
    files.map(async (filePath) => {
      const slug = slugFromPath(filePath);
      const source = await fs.readFile(filePath, "utf8");
      const { content, data } = parseFrontmatter(source);
      return {
        ...readMeta(slug, data),
        searchHeadings: readHeadings(content).map((heading) => heading.text)
      };
    })
  );
  return docs.sort((left, right) => {
    return (
      (productOrder.get(left.productId) ?? 999) - (productOrder.get(right.productId) ?? 999) ||
      (journeyOrder.get(left.journey) ?? 999) - (journeyOrder.get(right.journey) ?? 999) ||
      left.order - right.order ||
      left.title.localeCompare(right.title)
    );
  });
}

export async function getDoc(slug: string): Promise<DocPage | undefined> {
  try {
    const source = await fs.readFile(path.join(docsDirectory, `${slug}.md`), "utf8");
    const { content, data } = parseFrontmatter(source);
    return {
      ...readMeta(slug, data),
      contentHtml: await renderMarkdown(content),
      headings: readHeadings(content)
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function groupDocs(docs: Array<DocMeta & { slug: string; segments: string[] }>) {
  const products = new Map<string, Map<string, Array<DocMeta & { slug: string; segments: string[] }>>>();
  for (const doc of docs) {
    const product = products.get(doc.product) ?? new Map<string, Array<DocMeta & { slug: string; segments: string[] }>>();
    const section = product.get(doc.section) ?? [];
    section.push(doc);
    product.set(doc.section, section);
    products.set(doc.product, product);
  }
  return [...products.entries()].map(([product, sections]) => ({
    product,
    sections: [...sections.entries()]
  }));
}

export function groupProductDocs(
  docs: Array<DocMeta & { slug: string; segments: string[] }>,
  productId: ProductId
) {
  const productDocs = docs.filter((doc) => doc.productId === productId && doc.kind !== "product");
  return docsJourneys.map((journey) => {
    const entries = productDocs.filter((doc) => doc.journey === journey.id);
    const groups = new Map<string, typeof entries>();
    for (const entry of entries) {
      const group = groups.get(entry.section) ?? [];
      group.push(entry);
      groups.set(entry.section, group);
    }
    return {
      ...journey,
      entries,
      groups: [...groups.entries()]
    };
  }).filter((journey) => journey.entries.length > 0);
}

export function toSearchItems(docs: Array<DocMeta & { slug: string; segments: string[] }>) {
  return docs.map((doc) => ({
    slug: doc.slug,
    title: doc.title,
    navTitle: doc.navTitle,
    description: doc.description,
    product: doc.product,
    productId: doc.productId,
    section: doc.section,
    journey: doc.journey,
    searchHeadings: doc.searchHeadings,
    kind: doc.kind
  }));
}

import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { marked } from "marked";

const docsDirectory = path.join(process.cwd(), "content", "docs");
const productOrder = [
  "Start here",
  "Anvil Cloud",
  "Anvil Desktop",
  "Anvil Registry",
  "Anvil Node Base",
  "Project"
];

export type DocMeta = {
  title: string;
  navTitle: string;
  description: string;
  product: string;
  section: string;
  order: number;
};

export type DocPage = DocMeta & {
  slug: string;
  segments: string[];
  contentHtml: string;
};

marked.use({
  gfm: true,
  breaks: false
});

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

function readMeta(slug: string, data: matter.GrayMatterFile<string>["data"]): DocMeta & { slug: string; segments: string[] } {
  const segments = slug.split("/");
  const title = String(data.title ?? segments.at(-1) ?? slug);
  return {
    slug,
    segments,
    title,
    navTitle: String(data.navTitle ?? title),
    description: String(data.description ?? ""),
    product: String(data.product ?? segments[0] ?? "Project"),
    section: String(data.section ?? "Guides"),
    order: Number(data.order ?? 999)
  };
}

export async function getDocs(): Promise<Array<DocMeta & { slug: string; segments: string[] }>> {
  const files = await getMarkdownFiles(docsDirectory);
  const docs = await Promise.all(
    files.map(async (filePath) => {
      const slug = slugFromPath(filePath);
      const source = await fs.readFile(filePath, "utf8");
      const { data } = matter(source);
      return readMeta(slug, data);
    })
  );
  return docs.sort((left, right) => {
    const leftProduct = productOrder.indexOf(left.product);
    const rightProduct = productOrder.indexOf(right.product);

    return (
      (leftProduct === -1 ? 999 : leftProduct) - (rightProduct === -1 ? 999 : rightProduct) ||
      left.section.localeCompare(right.section) ||
      left.order - right.order ||
      left.title.localeCompare(right.title)
    );
  });
}

export async function getDoc(slug: string): Promise<DocPage | undefined> {
  try {
    const source = await fs.readFile(path.join(docsDirectory, `${slug}.md`), "utf8");
    const { content, data } = matter(source);
    return {
      ...readMeta(slug, data),
      contentHtml: await marked.parse(content)
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

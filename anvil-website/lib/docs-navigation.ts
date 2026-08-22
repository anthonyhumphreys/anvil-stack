export const docsJourneys = [
  {
    id: "learn",
    label: "Learn",
    description: "Understand what the product owns, how it works, and where its limits sit."
  },
  {
    id: "build",
    label: "Build",
    description: "Install, configure, run, deploy, and extend the product."
  },
  {
    id: "reference",
    label: "Reference",
    description: "Find commands, configuration, security notes, status, and troubleshooting."
  }
] as const;

export type JourneyId = (typeof docsJourneys)[number]["id"];

export const docsProducts = [
  {
    id: "start",
    label: "Start here",
    shortLabel: "Anvil",
    href: "/docs",
    folder: null,
    repoName: "anvil-stack/"
  },
  {
    id: "desktop",
    label: "Anvil Desktop",
    shortLabel: "Desktop",
    href: "/docs/desktop",
    folder: "desktop",
    repoName: "anvil-app/"
  },
  {
    id: "cloud",
    label: "Anvil Cloud",
    shortLabel: "Cloud",
    href: "/docs/cloud",
    folder: "cloud",
    repoName: "anvil-cloud/"
  },
  {
    id: "registry",
    label: "Anvil Registry",
    shortLabel: "Registry",
    href: "/docs/registry",
    folder: "registry",
    repoName: "anvil-registry/"
  },
  {
    id: "node-base",
    label: "Anvil Node Base",
    shortLabel: "Node Base",
    href: "/docs/node-base",
    folder: "node-base",
    repoName: "anvil-registry/devcontainer-base/"
  },
  {
    id: "project",
    label: "Project",
    shortLabel: "Project",
    href: "/docs/project/repositories",
    folder: "project",
    repoName: "anvil-stack/"
  }
] as const;

export type ProductId = (typeof docsProducts)[number]["id"];

export const productById = new Map(docsProducts.map((product) => [product.id, product]));
export const journeyById = new Map(docsJourneys.map((journey) => [journey.id, journey]));

const productIdByLabel = new Map<string, ProductId>(docsProducts.map((product) => [product.label, product.id]));

export function resolveProductId(product: string, segments: string[]): ProductId {
  const fromLabel = productIdByLabel.get(product);
  if (fromLabel) return fromLabel;

  const folder = segments[0];
  const fromFolder = docsProducts.find((entry) => entry.folder === folder);
  return fromFolder?.id ?? "start";
}

export function resolveJourneyId(value: unknown, section: string, slug: string): JourneyId {
  if (value === "learn" || value === "build" || value === "reference") return value;

  if (slug === "cli") return "build";
  if (/troubleshooting|security|status|limits|api-reference|cli-reference|database-guide/.test(slug)) {
    return "reference";
  }
  if (/installation|quickstart|examples|deploy|workflows|operating-guide|git-workflows|automations|testing|seeding|ci$/.test(slug)) {
    return "build";
  }

  if (["Getting started", "Runtime", "Working guide", "Guides", "Operations", "Deployment"].includes(section)) {
    return "build";
  }
  if (["Assurance", "Reference", "Project", "Notes"].includes(section)) return "reference";
  return "learn";
}

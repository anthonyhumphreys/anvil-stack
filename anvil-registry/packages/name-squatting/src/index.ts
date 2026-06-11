import { readFileSync } from "node:fs";

export const defaultPopularPackageIndexObjectKey = "popular-index/npm/latest.json";

export type PopularPackageIndexObjectStore = {
  get(key: string): Promise<Uint8Array | undefined>;
};

export type PopularPackage = {
  name: string;
  weeklyDownloads?: number;
  aliases?: string[];
};

export type PopularPackageIndex = {
  generatedAt?: string;
  source: string;
  popularPackages: PopularPackage[];
  knownConfusions: Record<string, string>;
};

export type NameSquattingSignal = {
  candidate: string;
  similarity: number;
  jaroWinklerSimilarity: number;
  distance: number;
  weeklyDownloads?: number;
  reasons: string[];
  suggestedPackage: string;
};

const trustedMirrorScopes = new Set(["@types"]);

export const defaultPopularPackages: PopularPackage[] = [
  { name: "lodash", weeklyDownloads: 60_000_000 },
  { name: "react", weeklyDownloads: 30_000_000 },
  { name: "@tanstack/react-query", weeklyDownloads: 4_000_000 },
  { name: "@vitejs/plugin-react", weeklyDownloads: 5_000_000 },
  { name: "vite", weeklyDownloads: 20_000_000 },
  { name: "typescript", weeklyDownloads: 50_000_000 },
  { name: "express", weeklyDownloads: 25_000_000 },
  { name: "fastify", weeklyDownloads: 3_000_000 }
];

export const knownEcosystemConfusions: Record<string, string> = {
  "@tenstack/react-query": "@tanstack/react-query",
  "@vite/plugin-react": "@vitejs/plugin-react",
  loadash: "lodash"
};

export const defaultPopularPackageIndex: PopularPackageIndex = {
  source: "built-in",
  popularPackages: defaultPopularPackages,
  knownConfusions: knownEcosystemConfusions
};

export function loadPopularPackageIndex(indexPath?: string): PopularPackageIndex {
  if (!indexPath) return defaultPopularPackageIndex;
  const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as unknown;
  return parsePopularPackageIndex(parsed, indexPath);
}

export async function loadActivePopularPackageIndex(options: {
  objectStore?: PopularPackageIndexObjectStore;
  objectKey?: string;
  indexPath?: string;
  fallback?: PopularPackageIndex;
}): Promise<PopularPackageIndex> {
  const objectIndex = options.objectStore && options.objectKey ? await loadPopularPackageIndexFromObjectStore(options.objectStore, options.objectKey) : undefined;
  if (objectIndex) return objectIndex;
  if (options.indexPath) return loadPopularPackageIndex(options.indexPath);
  return options.fallback ?? defaultPopularPackageIndex;
}

export async function loadPopularPackageIndexFromObjectStore(
  objectStore: PopularPackageIndexObjectStore,
  objectKey = defaultPopularPackageIndexObjectKey
): Promise<PopularPackageIndex | undefined> {
  const body = await objectStore.get(objectKey);
  if (!body) return undefined;
  return parsePopularPackageIndex(JSON.parse(new TextDecoder().decode(body)) as unknown, `object:${objectKey}`);
}

export function encodePopularPackageIndex(index: PopularPackageIndex): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify(
      {
        generatedAt: index.generatedAt,
        popularPackages: index.popularPackages,
        knownConfusions: index.knownConfusions
      },
      null,
      2
    )}\n`
  );
}

export function popularPackageIndexDatedObjectKey(generatedAt: string | Date = new Date()): string {
  const date = generatedAt instanceof Date ? generatedAt.toISOString().slice(0, 10) : generatedAt.slice(0, 10);
  return `popular-index/npm/${date}.json`;
}

export function parsePopularPackageIndex(value: unknown, source = "inline"): PopularPackageIndex {
  if (!isRecord(value)) throw new Error("Popular package index must be a JSON object.");
  const popularPackages = value.popularPackages ?? value.packages;
  if (!Array.isArray(popularPackages)) throw new Error("Popular package index requires a popularPackages array.");
  const knownConfusions = value.knownConfusions ?? value.knownEcosystemConfusions ?? {};
  if (!isRecord(knownConfusions)) throw new Error("Popular package index knownConfusions must be an object.");

  return {
    generatedAt: typeof value.generatedAt === "string" ? value.generatedAt : undefined,
    source,
    popularPackages: popularPackages.map(parsePopularPackage),
    knownConfusions: Object.fromEntries(
      Object.entries(knownConfusions).map(([requested, suggested]) => {
        if (typeof suggested !== "string" || !suggested) throw new Error(`Known confusion for ${requested} must be a package name.`);
        return [requested.toLowerCase(), suggested];
      })
    )
  };
}

export function splitPackageName(packageName: string): { scope?: string; name: string } {
  if (!packageName.startsWith("@")) return { name: packageName };
  const [scope, name] = packageName.split("/");
  return { scope, name: name ?? "" };
}

export function normaliseName(packageName: string): string {
  const { scope, name } = splitPackageName(packageName.toLowerCase());
  return `${scope ?? ""}/${name}`.replace(/[@/_-]/g, "");
}

export function damerauLevenshtein(a: string, b: string): number {
  const da = new Map<string, number>();
  const maxDistance = a.length + b.length;
  const matrix: number[][] = Array.from({ length: a.length + 2 }, () => Array<number>(b.length + 2).fill(0));

  matrix[0]![0] = maxDistance;
  for (let i = 0; i <= a.length; i += 1) {
    matrix[i + 1]![0] = maxDistance;
    matrix[i + 1]![1] = i;
  }
  for (let j = 0; j <= b.length; j += 1) {
    matrix[0]![j + 1] = maxDistance;
    matrix[1]![j + 1] = j;
  }

  for (let i = 1; i <= a.length; i += 1) {
    let db = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const i1 = da.get(b[j - 1]!) ?? 0;
      const j1 = db;
      let cost = 1;
      if (a[i - 1] === b[j - 1]) {
        cost = 0;
        db = j;
      }
      matrix[i + 1]![j + 1] = Math.min(
        matrix[i]![j]! + cost,
        matrix[i + 1]![j]! + 1,
        matrix[i]![j + 1]! + 1,
        matrix[i1]![j1]! + (i - i1 - 1) + 1 + (j - j1 - 1)
      );
    }
    da.set(a[i - 1]!, i);
  }

  return matrix[a.length + 1]![b.length + 1]!;
}

export function similarity(a: string, b: string): number {
  const left = normaliseName(a);
  const right = normaliseName(b);
  const maxLength = Math.max(left.length, right.length, 1);
  return 1 - damerauLevenshtein(left, right) / maxLength;
}

export function jaroWinklerSimilarity(a: string, b: string): number {
  const left = normaliseName(a);
  const right = normaliseName(b);
  if (left === right) return 1;
  if (!left || !right) return 0;

  const matchDistance = Math.max(Math.floor(Math.max(left.length, right.length) / 2) - 1, 0);
  const leftMatches = Array<boolean>(left.length).fill(false);
  const rightMatches = Array<boolean>(right.length).fill(false);
  let matches = 0;

  for (let i = 0; i < left.length; i += 1) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, right.length);
    for (let j = start; j < end; j += 1) {
      if (rightMatches[j] || left[i] !== right[j]) continue;
      leftMatches[i] = true;
      rightMatches[j] = true;
      matches += 1;
      break;
    }
  }

  if (matches === 0) return 0;

  const leftMatched = [...left].filter((_char, index) => leftMatches[index]);
  const rightMatched = [...right].filter((_char, index) => rightMatches[index]);
  const transpositions = leftMatched.filter((char, index) => char !== rightMatched[index]).length / 2;
  const jaro = (matches / left.length + matches / right.length + (matches - transpositions) / matches) / 3;
  const prefix = commonPrefixLength(left, right, 4);
  return Number((jaro + prefix * 0.1 * (1 - jaro)).toFixed(3));
}

export function detectNameSquatting(
  packageName: string,
  indexOrPackages: PopularPackage[] | PopularPackageIndex = defaultPopularPackageIndex
): NameSquattingSignal[] {
  const index = Array.isArray(indexOrPackages)
    ? { ...defaultPopularPackageIndex, popularPackages: indexOrPackages }
    : indexOrPackages;
  const requested = splitPackageName(packageName);
  const knownCandidate = index.knownConfusions[packageName.toLowerCase()];

  return index.popularPackages
    .filter((candidate) => candidate.name !== packageName)
    .flatMap((candidate) => {
      const candidateParts = splitPackageName(candidate.name);
      if (isTrustedScopeMirror(requested, candidateParts)) return [];
      const candidateNames = [candidate.name, ...(candidate.aliases ?? [])];
      const scores = candidateNames.map((name) => ({
        name,
        editSimilarity: similarity(packageName, name),
        jaroWinkler: jaroWinklerSimilarity(packageName, name),
        distance: damerauLevenshtein(normaliseName(packageName), normaliseName(name))
      }));
      const best = scores.sort((a, b) => Math.max(b.editSimilarity, b.jaroWinkler) - Math.max(a.editSimilarity, a.jaroWinkler))[0]!;
      const scopeConfusion = Boolean(
        requested.name &&
          candidateParts.name &&
          requested.scope !== candidateParts.scope &&
          normaliseName(requested.name) === normaliseName(candidateParts.name)
      );
      const score = scopeConfusion ? Math.max(best.editSimilarity, best.jaroWinkler, 1) : Math.max(best.editSimilarity, best.jaroWinkler);
      const distance = damerauLevenshtein(normaliseName(packageName), normaliseName(candidate.name));
      const reasons: string[] = [];

      if (scopeConfusion || (best.editSimilarity >= 0.82 && hasComparableLength(packageName, best.name))) reasons.push("high_name_similarity");
      if (best.jaroWinkler >= 0.9 && best.distance <= 2) reasons.push("high_jaro_winkler_similarity");
      if (knownCandidate === candidate.name || candidate.aliases?.some((alias) => alias.toLowerCase() === packageName.toLowerCase())) {
        reasons.push("known_ecosystem_confusion");
      }
      if (scopeConfusion) reasons.push("scope_confusion");
      if (requested.name !== candidateParts.name && requested.name.replace(/[-_]/g, "") === candidateParts.name.replace(/[-_]/g, "")) {
        reasons.push("hyphen_or_underscore_variant");
      }
      if (isPluralisationVariant(requested.name, candidateParts.name)) reasons.push("pluralisation_variant");
      if (requested.scope && candidateParts.scope && Math.max(similarity(requested.scope, candidateParts.scope), jaroWinklerSimilarity(requested.scope, candidateParts.scope)) >= 0.75) {
        reasons.push("similar_scope");
      }
      reasons.push(...editPatternReasons(normaliseName(packageName), normaliseName(candidate.name)));
      if (normaliseVisual(packageName) === normaliseVisual(candidate.name) && normaliseName(packageName) !== normaliseName(candidate.name)) {
        reasons.push("visual_similarity");
      }
      if (distance <= 2) reasons.push("short_edit_distance");

      return [{
        candidate: candidate.name,
        similarity: Number(score.toFixed(3)),
        jaroWinklerSimilarity: best.jaroWinkler,
        distance,
        weeklyDownloads: candidate.weeklyDownloads,
        reasons: [...new Set(reasons)],
        suggestedPackage: candidate.name
      }];
    })
    .filter((signal) => signal.reasons.length > 0)
    .sort((a, b) => b.similarity - a.similarity);
}

function isTrustedScopeMirror(requested: { scope?: string; name: string }, candidate: { scope?: string; name: string }) {
  return Boolean(
    requested.scope &&
      trustedMirrorScopes.has(requested.scope) &&
      !candidate.scope &&
      requested.name &&
      normaliseSegment(requested.name) === normaliseSegment(candidate.name)
  );
}

function hasComparableLength(a: string, b: string) {
  const left = normaliseName(a);
  const right = normaliseName(b);
  const shorter = Math.min(left.length, right.length);
  const longer = Math.max(left.length, right.length, 1);
  return shorter / longer >= 0.72;
}

function commonPrefixLength(a: string, b: string, maxLength: number): number {
  let length = 0;
  while (length < maxLength && a[length] && a[length] === b[length]) length += 1;
  return length;
}

function isPluralisationVariant(a: string, b: string): boolean {
  const left = a.toLowerCase().replace(/[-_]/g, "");
  const right = b.toLowerCase().replace(/[-_]/g, "");
  if (left === right) return false;
  return stripPlural(left) === right || stripPlural(right) === left;
}

function stripPlural(value: string): string {
  if (value.endsWith("ies") && value.length > 3) return `${value.slice(0, -3)}y`;
  if (value.endsWith("es") && value.length > 2) return value.slice(0, -2);
  if (value.endsWith("s") && value.length > 1) return value.slice(0, -1);
  return value;
}

function normaliseSegment(value: string): string {
  return value.toLowerCase().replace(/[-_]/g, "");
}

function editPatternReasons(requested: string, candidate: string): string[] {
  if (requested === candidate) return [];
  if (Math.abs(requested.length - candidate.length) === 1 && oneInsertionAway(requested, candidate)) {
    return [requested.length < candidate.length ? "missing_character" : "extra_character"];
  }
  if (requested.length === candidate.length && oneTranspositionAway(requested, candidate)) return ["transposed_characters"];
  return [];
}

function oneInsertionAway(a: string, b: string): boolean {
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  let skipped = false;
  for (let i = 0, j = 0; i < shorter.length || j < longer.length; i += 1, j += 1) {
    if (shorter[i] === longer[j]) continue;
    if (skipped) return false;
    skipped = true;
    i -= 1;
  }
  return true;
}

function oneTranspositionAway(a: string, b: string): boolean {
  const indexes = [...a].flatMap((char, index) => (char === b[index] ? [] : [index]));
  return indexes.length === 2 && a[indexes[0]!] === b[indexes[1]!] && a[indexes[1]!] === b[indexes[0]!];
}

function normaliseVisual(value: string): string {
  return normaliseName(value)
    .replace(/[0o]/g, "o")
    .replace(/[1il]/g, "l")
    .replace(/[5s]/g, "s")
    .replace(/[2z]/g, "z")
    .replace(/[8b]/g, "b");
}

function parsePopularPackage(value: unknown): PopularPackage {
  if (!isRecord(value)) throw new Error("Popular package entries must be objects.");
  if (typeof value.name !== "string" || !value.name) throw new Error("Popular package entries require a name.");
  if (value.weeklyDownloads !== undefined && (typeof value.weeklyDownloads !== "number" || value.weeklyDownloads < 0)) {
    throw new Error(`Popular package ${value.name} has invalid weeklyDownloads.`);
  }
  if (value.aliases !== undefined && (!Array.isArray(value.aliases) || value.aliases.some((alias) => typeof alias !== "string" || !alias))) {
    throw new Error(`Popular package ${value.name} has invalid aliases.`);
  }
  return {
    name: value.name,
    weeklyDownloads: value.weeklyDownloads,
    aliases: value.aliases
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

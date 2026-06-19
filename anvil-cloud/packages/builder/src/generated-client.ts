import type { CellManifest } from "./manifest.js";

export function renderGeneratedClient(manifest: CellManifest): string {
  return [
    'import type { GeneratedAnvilApi } from "@anvil-cloud/client";',
    "",
    "export const api = {",
    "  queries: {",
    ...manifest.queries.map(
      (name) =>
        `    ${propertyName(name)}: { kind: "query", name: ${JSON.stringify(name)} },`,
    ),
    "  },",
    "  mutations: {",
    ...manifest.mutations.map(
      (name) =>
        `    ${propertyName(name)}: { kind: "mutation", name: ${JSON.stringify(name)} },`,
    ),
    "  },",
    "} as const satisfies GeneratedAnvilApi;",
    "",
  ].join("\n");
}

export function renderGeneratedTypes(manifest: CellManifest): string {
  return [
    'import type { ApiMutation, ApiQuery } from "@anvil-cloud/client";',
    "",
    "export declare const api: {",
    "  readonly queries: {",
    ...manifest.queries.map(
      (name) =>
        `    readonly ${propertyName(name)}: ApiQuery<${JSON.stringify(name)}>;`,
    ),
    "  };",
    "  readonly mutations: {",
    ...manifest.mutations.map(
      (name) =>
        `    readonly ${propertyName(name)}: ApiMutation<${JSON.stringify(name)}>;`,
    ),
    "  };",
    "};",
    "",
  ].join("\n");
}

export function renderGeneratedClientTypecheckStub(): string {
  return [
    'import type { GeneratedAnvilApi } from "@anvil-cloud/client";',
    "",
    "export const api = {",
    "  queries: {},",
    "  mutations: {},",
    "} as GeneratedAnvilApi;",
    "",
  ].join("\n");
}

function propertyName(name: string): string {
  if (/^[A-Za-z_$][\w$]*$/.test(name)) {
    return name;
  }

  return JSON.stringify(name);
}

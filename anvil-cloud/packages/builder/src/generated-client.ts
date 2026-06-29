import type { CellManifest } from "./manifest.js";

export function renderGeneratedClient(manifest: CellManifest): string {
  return [
    'import { createApiClient, createClient } from "@anvil-cloud/client";',
    'import type { AnvilClientOptions, ApiMutation, ApiQuery, GeneratedAnvilApi } from "@anvil-cloud/client";',
    "",
    "export interface QueryTypes {}",
    "export interface MutationTypes {}",
    "",
    "export const api = {",
    "  queries: {",
    ...manifest.queries.map(
      (name) =>
        `    ${propertyName(name)}: { kind: "query", name: ${JSON.stringify(name)} } as TypedQuery<${JSON.stringify(name)}>,`,
    ),
    "  },",
    "  mutations: {",
    ...manifest.mutations.map(
      (name) =>
        `    ${propertyName(name)}: { kind: "mutation", name: ${JSON.stringify(name)} } as TypedMutation<${JSON.stringify(name)}>,`,
    ),
    "  },",
    "  meta: {",
    '    schemaVersion: "0.1",',
    `    queries: ${JSON.stringify(sortedNames(manifest.queries))},`,
    `    mutations: ${JSON.stringify(sortedNames(manifest.mutations))},`,
    "  },",
    "} as const satisfies GeneratedAnvilApi;",
    "",
    "export function createAnvilApiClient(options: AnvilClientOptions = {}) {",
    "  return createApiClient(createClient(options), api);",
    "}",
    "",
    "type TypedQuery<TName extends string> = TName extends keyof QueryTypes",
    "  ? QueryTypes[TName] extends { input: infer TInput; result: infer TResult }",
    "    ? ApiQuery<TName, TInput, TResult>",
    "    : ApiQuery<TName>",
    "  : ApiQuery<TName>;",
    "",
    "type TypedMutation<TName extends string> = TName extends keyof MutationTypes",
    "  ? MutationTypes[TName] extends { input: infer TInput; result: infer TResult }",
    "    ? ApiMutation<TName, TInput, TResult>",
    "    : ApiMutation<TName>",
    "  : ApiMutation<TName>;",
    "",
  ].join("\n");
}

export function renderGeneratedTypes(manifest: CellManifest): string {
  return [
    'import type { AnvilClientOptions, ApiMutation, ApiQuery, GeneratedAnvilApiClient } from "@anvil-cloud/client";',
    "",
    "export interface QueryTypes {}",
    "export interface MutationTypes {}",
    "",
    "export declare const api: {",
    "  readonly queries: {",
    ...manifest.queries.map(
      (name) =>
        `    readonly ${propertyName(name)}: TypedQuery<${JSON.stringify(name)}>;`,
    ),
    "  };",
    "  readonly mutations: {",
    ...manifest.mutations.map(
      (name) =>
        `    readonly ${propertyName(name)}: TypedMutation<${JSON.stringify(name)}>;`,
    ),
    "  };",
    "  readonly meta: {",
    '    readonly schemaVersion: "0.1";',
    "    readonly queries: readonly string[];",
    "    readonly mutations: readonly string[];",
    "  };",
    "};",
    "",
    "export declare function createAnvilApiClient(",
    "  options?: AnvilClientOptions,",
    "): GeneratedAnvilApiClient<typeof api>;",
    "",
    "type TypedQuery<TName extends string> = TName extends keyof QueryTypes",
    "  ? QueryTypes[TName] extends { input: infer TInput; result: infer TResult }",
    "    ? ApiQuery<TName, TInput, TResult>",
    "    : ApiQuery<TName>",
    "  : ApiQuery<TName>;",
    "",
    "type TypedMutation<TName extends string> = TName extends keyof MutationTypes",
    "  ? MutationTypes[TName] extends { input: infer TInput; result: infer TResult }",
    "    ? ApiMutation<TName, TInput, TResult>",
    "    : ApiMutation<TName>",
    "  : ApiMutation<TName>;",
    "",
  ].join("\n");
}

export function renderGeneratedClientTypecheckStub(): string {
  return [
    'import type { AnvilClientOptions, ApiMutation, ApiQuery, GeneratedAnvilApi, GeneratedAnvilApiClient } from "@anvil-cloud/client";',
    "",
    "export interface QueryTypes {}",
    "export interface MutationTypes {}",
    "",
    "export const api: {",
    "  readonly queries: GeneratedQueries;",
    "  readonly mutations: GeneratedMutations;",
    "  readonly meta: {",
    '    readonly schemaVersion: "0.1";',
    "    readonly queries: readonly string[];",
    "    readonly mutations: readonly string[];",
    "  };",
    "} & GeneratedAnvilApi = {",
    "  queries: {} as GeneratedQueries,",
    "  mutations: {} as GeneratedMutations,",
    '  meta: { schemaVersion: "0.1", queries: [], mutations: [] },',
    "};",
    "",
    "export function createAnvilApiClient(",
    "  _options: AnvilClientOptions = {},",
    "): GeneratedAnvilApiClient<typeof api> {",
    "  throw new Error('Generated Anvil client is only available after anvil-cloud build.');",
    "}",
    "",
    "type GeneratedQueries = {",
    "  readonly [TName in keyof QueryTypes]: TName extends string ? TypedQuery<TName> : never;",
    "} & Record<string, ApiQuery>;",
    "",
    "type GeneratedMutations = {",
    "  readonly [TName in keyof MutationTypes]: TName extends string ? TypedMutation<TName> : never;",
    "} & Record<string, ApiMutation>;",
    "",
    "type TypedQuery<TName extends string> = TName extends keyof QueryTypes",
    "  ? QueryTypes[TName] extends { input: infer TInput; result: infer TResult }",
    "    ? ApiQuery<TName, TInput, TResult>",
    "    : ApiQuery<TName>",
    "  : ApiQuery<TName>;",
    "",
    "type TypedMutation<TName extends string> = TName extends keyof MutationTypes",
    "  ? MutationTypes[TName] extends { input: infer TInput; result: infer TResult }",
    "    ? ApiMutation<TName, TInput, TResult>",
    "    : ApiMutation<TName>",
    "  : ApiMutation<TName>;",
    "",
  ].join("\n");
}

function propertyName(name: string): string {
  if (/^[A-Za-z_$][\w$]*$/.test(name)) {
    return name;
  }

  return JSON.stringify(name);
}

function sortedNames(names: string[]): string[] {
  return [...names].sort();
}

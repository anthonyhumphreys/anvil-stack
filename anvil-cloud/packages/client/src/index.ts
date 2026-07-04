export type ApiQuery<
  TName extends string = string,
  TInput = unknown,
  TResult = unknown,
> = {
  kind: "query";
  name: TName;
  input?: TInput | undefined;
  result?: TResult | undefined;
};

export type ApiMutation<
  TName extends string = string,
  TInput = unknown,
  TResult = unknown,
> = {
  kind: "mutation";
  name: TName;
  input?: TInput | undefined;
  result?: TResult | undefined;
};

export type GeneratedAnvilApi = {
  meta?: GeneratedAnvilApiMeta;
  queries: Record<string, ApiQuery>;
  mutations: Record<string, ApiMutation>;
};

export type GeneratedAnvilApiMeta = {
  schemaVersion: "0.1";
  queries: readonly string[];
  mutations: readonly string[];
};

export type GeneratedQueryClient<
  TQueries extends Record<string, ApiQuery> = Record<string, ApiQuery>,
> = {
  [TName in keyof TQueries]: (
    input: QueryInput<TQueries[TName]>,
  ) => Promise<QueryResultValue<TQueries[TName]>>;
};

export type GeneratedMutationClient<
  TMutations extends Record<string, ApiMutation> = Record<string, ApiMutation>,
> = {
  [TName in keyof TMutations]: (
    input: MutationInput<TMutations[TName]>,
  ) => Promise<MutationResultValue<TMutations[TName]>>;
};

export type GeneratedAnvilApiClient<TApi extends GeneratedAnvilApi> = {
  meta: TApi["meta"] extends GeneratedAnvilApiMeta
    ? TApi["meta"]
    : GeneratedAnvilApiMeta;
  queries: GeneratedQueryClient<TApi["queries"]>;
  mutations: GeneratedMutationClient<TApi["mutations"]>;
};

export type QueryInput<TQuery> =
  TQuery extends ApiQuery<string, infer TInput, any> ? TInput : unknown;

export type QueryResultValue<TQuery> =
  TQuery extends ApiQuery<string, any, infer TResult> ? TResult : unknown;

export type MutationInput<TMutation> =
  TMutation extends ApiMutation<string, infer TInput, any> ? TInput : unknown;

export type MutationResultValue<TMutation> =
  TMutation extends ApiMutation<string, any, infer TResult> ? TResult : unknown;

export type AnvilClientOptions = {
  runtimeUrl?: string;
  fetch?: typeof fetch;
  getAuth?: () => unknown | Promise<unknown>;
  getToken?: () => string | null | Promise<string | null>;
};

export type MutationState<TResult = unknown> = {
  status: "idle" | "loading" | "success" | "error";
  data: TResult | null;
  error: Error | null;
};

export type QueryState<TResult = unknown> = {
  status: "idle" | "loading" | "success" | "error";
  data: TResult | null;
  error: Error | null;
};

export type QueryResult<TResult = unknown> = QueryState<TResult> & {
  refetch: () => Promise<TResult>;
};

export type QueryOptions = {
  enabled?: boolean;
};

export type QueryRefetchTarget = Pick<QueryResult<unknown>, "refetch">;

export type MutationOptions<TResult = unknown> = {
  onSuccess?: (data: TResult) => void | Promise<void>;
  refetch?:
    | QueryRefetchTarget
    | (() => Promise<unknown>)
    | readonly (QueryRefetchTarget | (() => Promise<unknown>))[];
};

export type AnvilClientRequestInfo = {
  kind: "query" | "mutation";
  name: string;
  path: string;
};

export class AnvilClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly request: AnvilClientRequestInfo | undefined;

  constructor(options: {
    status: number;
    code: string;
    message: string;
    details?: unknown;
    request?: AnvilClientRequestInfo;
  }) {
    super(options.message);
    this.name = "AnvilClientError";
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
    this.request = options.request;
  }
}

export function isAnvilClientError(error: unknown): error is AnvilClientError {
  return error instanceof AnvilClientError;
}

export type HookRuntime = {
  useCallback<T extends (...args: any[]) => unknown>(
    callback: T,
    deps: unknown[],
  ): T;
  useEffect(effect: () => void | (() => void), deps: unknown[]): void;
  useMemo<T>(factory: () => T, deps: unknown[]): T;
  useRef<T>(initial: T): { current: T };
  useState<T>(
    initial: T | (() => T),
  ): [T, (value: T | ((previous: T) => T)) => void];
};

export class AnvilClient {
  private readonly runtimeUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly getAuth: (() => unknown | Promise<unknown>) | undefined;
  private readonly getToken:
    | (() => string | null | Promise<string | null>)
    | undefined;
  private token: string | null = null;

  constructor(options: AnvilClientOptions = {}) {
    this.runtimeUrl = trimTrailingSlash(options.runtimeUrl ?? "");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.getAuth = options.getAuth;
    this.getToken = options.getToken;

    if (!this.fetchImpl) {
      throw new Error("A fetch implementation is required.");
    }
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  async query<TInput = unknown, TResult = unknown>(
    definition: ApiQuery,
    input: TInput,
  ): Promise<TResult> {
    validateApiDefinition(definition, "query");
    const path = runtimeRoutePath("query", definition.name);

    return this.callRuntime<TResult>(path, input, {
      kind: "query",
      name: definition.name,
      path,
    });
  }

  async mutation<TInput = unknown, TResult = unknown>(
    definition: ApiMutation,
    input: TInput,
  ): Promise<TResult> {
    validateApiDefinition(definition, "mutation");
    const path = runtimeRoutePath("mutation", definition.name);

    return this.callRuntime<TResult>(path, input, {
      kind: "mutation",
      name: definition.name,
      path,
    });
  }

  private async callRuntime<TResult>(
    path: string,
    input: unknown,
    request: AnvilClientRequestInfo,
  ): Promise<TResult> {
    const token = this.getToken ? await this.getToken() : this.token;
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };

    if (token) {
      headers.authorization = `Bearer ${token}`;
    }

    const auth =
      token === null || token === undefined
        ? this.getAuth
          ? await this.getAuth()
          : undefined
        : undefined;
    let response: Response;

    try {
      response = await this.fetchImpl(`${this.runtimeUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(auth === undefined ? { input } : { input, auth }),
      });
    } catch (error) {
      throw new AnvilClientError({
        status: 0,
        code: "NETWORK_ERROR",
        message: "Runtime request failed before a response was received.",
        details: errorDetails(error),
        request,
      });
    }

    const payload = await readRuntimePayload<TResult>(response, request);

    if (!response.ok) {
      throw errorFromPayload(response.status, payload, request);
    }

    if (!payload.ok) {
      throw errorFromPayload(response.status, payload, request);
    }

    return payload.result as TResult;
  }
}

export function createClient(options: AnvilClientOptions = {}): AnvilClient {
  return new AnvilClient(options);
}

export function createApiClient<TApi extends GeneratedAnvilApi>(
  client: AnvilClient,
  api: TApi,
): GeneratedAnvilApiClient<TApi> {
  validateGeneratedApi(api);

  const queries = Object.fromEntries(
    Object.entries(api.queries).map(([name, definition]) => [
      name,
      (input: unknown) => client.query(definition, input),
    ]),
  ) as GeneratedQueryClient<TApi["queries"]>;
  const mutations = Object.fromEntries(
    Object.entries(api.mutations).map(([name, definition]) => [
      name,
      (input: unknown) => client.mutation(definition, input),
    ]),
  ) as GeneratedMutationClient<TApi["mutations"]>;

  return {
    meta: generatedApiMeta(api) as GeneratedAnvilApiClient<TApi>["meta"],
    queries,
    mutations,
  };
}

export function createAnvilHooks(client: AnvilClient, hooks: HookRuntime) {
  return {
    useQuery<TQuery extends ApiQuery>(
      definition: TQuery,
      input: QueryInput<TQuery>,
      options: QueryOptions = {},
    ): QueryResult<QueryResultValue<TQuery>> {
      const enabled = options.enabled ?? true;
      const [state, setState] = hooks.useState<
        QueryState<QueryResultValue<TQuery>>
      >({
        status: enabled ? "loading" : "idle",
        data: null,
        error: null,
      });
      const stableInput = hooks.useMemo(() => input, [JSON.stringify(input)]);
      const refetch = hooks.useCallback(async () => {
        setState({
          status: "loading",
          data: null,
          error: null,
        });

        try {
          const data = await client.query<
            QueryInput<TQuery>,
            QueryResultValue<TQuery>
          >(definition, stableInput);

          setState({
            status: "success",
            data,
            error: null,
          });

          return data;
        } catch (error) {
          const normalized = toError(error);

          setState({
            status: "error",
            data: null,
            error: normalized,
          });
          throw normalized;
        }
      }, [definition.name, stableInput]);

      hooks.useEffect(() => {
        if (!enabled) {
          setState({
            status: "idle",
            data: null,
            error: null,
          });
          return;
        }

        let active = true;

        setState({
          status: "loading",
          data: null,
          error: null,
        });
        void client
          .query<QueryInput<TQuery>, QueryResultValue<TQuery>>(
            definition,
            stableInput,
          )
          .then((data) => {
            if (active) {
              setState({
                status: "success",
                data,
                error: null,
              });
            }
          })
          .catch((error: unknown) => {
            if (active) {
              setState({
                status: "error",
                data: null,
                error: toError(error),
              });
            }
          });

        return () => {
          active = false;
        };
      }, [definition.name, stableInput, enabled]);

      return {
        ...state,
        refetch,
      };
    },

    useMutation<TMutation extends ApiMutation>(
      definition: TMutation,
      options: MutationOptions<MutationResultValue<TMutation>> = {},
    ): MutationState<MutationResultValue<TMutation>> & {
      mutate: (
        input: MutationInput<TMutation>,
      ) => Promise<MutationResultValue<TMutation>>;
    } {
      const [state, setState] = hooks.useState<
        MutationState<MutationResultValue<TMutation>>
      >({
        status: "idle",
        data: null,
        error: null,
      });
      const optionsRef =
        hooks.useRef<MutationOptions<MutationResultValue<TMutation>>>(options);
      optionsRef.current = options;
      const mutate = hooks.useCallback(
        async (input: MutationInput<TMutation>) => {
          setState({
            status: "loading",
            data: null,
            error: null,
          });

          try {
            const data = await client.mutation<
              MutationInput<TMutation>,
              MutationResultValue<TMutation>
            >(definition, input);

            setState({
              status: "success",
              data,
              error: null,
            });

            await optionsRef.current.onSuccess?.(data);
            await refetchAfterMutation(optionsRef.current.refetch);

            return data;
          } catch (error) {
            const normalized = toError(error);

            setState({
              status: "error",
              data: null,
              error: normalized,
            });
            throw normalized;
          }
        },
        [definition.name],
      );

      return {
        ...state,
        mutate,
      };
    },
  };
}

async function refetchAfterMutation(
  refetch:
    | QueryRefetchTarget
    | (() => Promise<unknown>)
    | readonly (QueryRefetchTarget | (() => Promise<unknown>))[]
    | undefined,
): Promise<void> {
  if (refetch === undefined) {
    return;
  }

  const targets = Array.isArray(refetch) ? refetch : [refetch];

  await Promise.all(
    targets.map((target) =>
      typeof target === "function" ? target() : target.refetch(),
    ),
  );
}

type RuntimePayload<TResult> =
  | {
      ok: true;
      result: TResult;
    }
  | {
      ok: false;
      error?: {
        code: string;
        message: string;
        details?: unknown;
      };
    };

async function readRuntimePayload<TResult>(
  response: Response,
  request: AnvilClientRequestInfo,
): Promise<RuntimePayload<TResult>> {
  let payload: unknown;

  try {
    payload = await response.json();
  } catch (error) {
    throw new AnvilClientError({
      status: response.status,
      code: "INVALID_RUNTIME_RESPONSE",
      message: "Runtime response was not valid JSON.",
      details: errorDetails(error),
      request,
    });
  }

  if (!isRuntimePayload(payload)) {
    throw new AnvilClientError({
      status: response.status,
      code: "INVALID_RUNTIME_RESPONSE",
      message:
        "Runtime response did not match the Anvil runtime payload shape.",
      details: {
        payload,
      },
      request,
    });
  }

  return payload as RuntimePayload<TResult>;
}

function isRuntimePayload(value: unknown): value is RuntimePayload<unknown> {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }

  if (value.ok === true) {
    return true;
  }

  if (value.ok !== false) {
    return false;
  }

  if (!("error" in value) || value.error === undefined) {
    return true;
  }

  const error = value.error;

  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    "message" in error &&
    typeof error.message === "string"
  );
}

function errorFromPayload(
  status: number,
  payload: RuntimePayload<unknown>,
  request: AnvilClientRequestInfo,
): AnvilClientError {
  return new AnvilClientError({
    status,
    code: payload.ok ? "HTTP_ERROR" : (payload.error?.code ?? "RUNTIME_ERROR"),
    message: payload.ok
      ? `Runtime request failed with ${status}.`
      : (payload.error?.message ?? "Runtime request failed."),
    details: payload.ok ? undefined : payload.error?.details,
    request,
  });
}

function validateApiDefinition(
  definition: ApiQuery | ApiMutation,
  expectedKind: "query" | "mutation",
): void {
  if (
    typeof definition !== "object" ||
    definition === null ||
    definition.kind !== expectedKind ||
    typeof definition.name !== "string" ||
    definition.name.length === 0
  ) {
    throw new AnvilClientError({
      status: 0,
      code: "INVALID_API_DEFINITION",
      message: `Generated Anvil ${expectedKind} metadata is invalid.`,
      details: {
        expectedKind,
        definition,
      },
    });
  }
}

function validateGeneratedApi(api: GeneratedAnvilApi): void {
  if (
    typeof api !== "object" ||
    api === null ||
    !isRouteRecord(api.queries) ||
    !isRouteRecord(api.mutations)
  ) {
    throw new AnvilClientError({
      status: 0,
      code: "INVALID_API_DEFINITION",
      message: "Generated Anvil API metadata is invalid.",
      details: {
        api,
      },
    });
  }

  validateGeneratedApiMeta(api);
}

function isRouteRecord(value: unknown): value is Record<string, ApiQuery | ApiMutation> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateGeneratedApiMeta(api: GeneratedAnvilApi): void {
  if (api.meta === undefined) {
    return;
  }

  const meta = api.meta;

  if (
    typeof meta !== "object" ||
    meta === null ||
    meta.schemaVersion !== "0.1" ||
    !isStringArray(meta.queries) ||
    !isStringArray(meta.mutations)
  ) {
    throw invalidGeneratedApiMetadata({
      reason: "invalid-meta",
      meta,
    });
  }

  const actualQueries = sortedKeys(api.queries);
  const actualMutations = sortedKeys(api.mutations);
  const metaQueries = sortedUnique(meta.queries);
  const metaMutations = sortedUnique(meta.mutations);

  if (
    !sameStringArray(metaQueries, actualQueries) ||
    !sameStringArray(metaMutations, actualMutations)
  ) {
    throw invalidGeneratedApiMetadata({
      reason: "meta-route-mismatch",
      expected: {
        queries: actualQueries,
        mutations: actualMutations,
      },
      actual: {
        queries: metaQueries,
        mutations: metaMutations,
      },
    });
  }
}

function generatedApiMeta(api: GeneratedAnvilApi): GeneratedAnvilApiMeta {
  return (
    api.meta ?? {
      schemaVersion: "0.1",
      queries: sortedKeys(api.queries),
      mutations: sortedKeys(api.mutations),
    }
  );
}

function invalidGeneratedApiMetadata(details: unknown): AnvilClientError {
  return new AnvilClientError({
    status: 0,
    code: "INVALID_API_DEFINITION",
    message: "Generated Anvil API metadata is invalid.",
    details,
  });
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function sortedKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).sort();
}

function sortedUnique(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function runtimeRoutePath(kind: "query" | "mutation", name: string): string {
  return `/_anvil/${kind}/${encodeURIComponent(name)}`;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorDetails(error: unknown): Record<string, string> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    message: String(error),
  };
}

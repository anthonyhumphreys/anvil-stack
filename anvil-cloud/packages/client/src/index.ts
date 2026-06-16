export type ApiQuery<TName extends string = string> = {
  kind: "query";
  name: TName;
};

export type ApiMutation<TName extends string = string> = {
  kind: "mutation";
  name: TName;
};

export type GeneratedAnvilApi = {
  queries: Record<string, ApiQuery>;
  mutations: Record<string, ApiMutation>;
};

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
  status: "loading" | "success" | "error";
  data: TResult | null;
  error: Error | null;
};

export type QueryResult<TResult = unknown> = QueryState<TResult> & {
  refetch: () => Promise<TResult>;
};

export class AnvilClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(options: {
    status: number;
    code: string;
    message: string;
    details?: unknown;
  }) {
    super(options.message);
    this.name = "AnvilClientError";
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
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
    return this.callRuntime<TResult>(`/_anvil/query/${definition.name}`, input);
  }

  async mutation<TInput = unknown, TResult = unknown>(
    definition: ApiMutation,
    input: TInput,
  ): Promise<TResult> {
    return this.callRuntime<TResult>(
      `/_anvil/mutation/${definition.name}`,
      input,
    );
  }

  private async callRuntime<TResult>(
    path: string,
    input: unknown,
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
    const response = await this.fetchImpl(`${this.runtimeUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(auth === undefined ? { input } : { input, auth }),
    });
    const payload = (await response.json()) as RuntimePayload<TResult>;

    if (!response.ok) {
      throw errorFromPayload(response.status, payload);
    }

    if (!payload.ok) {
      throw errorFromPayload(response.status, payload);
    }

    return payload.result as TResult;
  }
}

export function createClient(options: AnvilClientOptions = {}): AnvilClient {
  return new AnvilClient(options);
}

export function createAnvilHooks(client: AnvilClient, hooks: HookRuntime) {
  return {
    useQuery<TInput = unknown, TResult = unknown>(
      definition: ApiQuery,
      input: TInput,
    ): QueryResult<TResult> {
      const [state, setState] = hooks.useState<QueryState<TResult>>({
        status: "loading",
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
          const data = await client.query<TInput, TResult>(
            definition,
            stableInput,
          );

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
        let active = true;

        setState({
          status: "loading",
          data: null,
          error: null,
        });
        void client
          .query<TInput, TResult>(definition, stableInput)
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
      }, [definition.name, stableInput]);

      return {
        ...state,
        refetch,
      };
    },

    useMutation<TInput = unknown, TResult = unknown>(
      definition: ApiMutation,
    ): MutationState<TResult> & {
      mutate: (input: TInput) => Promise<TResult>;
    } {
      const [state, setState] = hooks.useState<MutationState<TResult>>({
        status: "idle",
        data: null,
        error: null,
      });
      const mutate = hooks.useCallback(
        async (input: TInput) => {
          setState({
            status: "loading",
            data: null,
            error: null,
          });

          try {
            const data = await client.mutation<TInput, TResult>(
              definition,
              input,
            );

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

function errorFromPayload(
  status: number,
  payload: RuntimePayload<unknown>,
): AnvilClientError {
  return new AnvilClientError({
    status,
    code: payload.ok ? "HTTP_ERROR" : (payload.error?.code ?? "RUNTIME_ERROR"),
    message: payload.ok
      ? `Runtime request failed with ${status}.`
      : (payload.error?.message ?? "Runtime request failed."),
    details: payload.ok ? undefined : payload.error?.details,
  });
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

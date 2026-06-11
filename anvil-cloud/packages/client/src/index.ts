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

  constructor(options: AnvilClientOptions = {}) {
    this.runtimeUrl = trimTrailingSlash(options.runtimeUrl ?? "");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.getAuth = options.getAuth;

    if (!this.fetchImpl) {
      throw new Error("A fetch implementation is required.");
    }
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
    const auth = this.getAuth ? await this.getAuth() : undefined;
    const response = await this.fetchImpl(`${this.runtimeUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(auth === undefined ? { input } : { input, auth }),
    });
    const payload = (await response.json()) as RuntimePayload<TResult>;

    if (!response.ok) {
      throw new Error(
        payload.ok
          ? `Runtime request failed with ${response.status}.`
          : (payload.error?.message ??
              `Runtime request failed with ${response.status}.`),
      );
    }

    if (!payload.ok) {
      throw new Error(payload.error?.message ?? "Runtime request failed.");
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
    ): QueryState<TResult> {
      const [state, setState] = hooks.useState<QueryState<TResult>>({
        status: "loading",
        data: null,
        error: null,
      });
      const stableInput = hooks.useMemo(() => input, [JSON.stringify(input)]);

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

      return state;
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
      };
    };

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

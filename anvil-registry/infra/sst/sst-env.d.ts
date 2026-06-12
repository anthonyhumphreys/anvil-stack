declare const $config: (config: unknown) => unknown;
declare const $interpolate: (strings: TemplateStringsArray, ...values: unknown[]) => string;
declare const sst: {
  Secret: new (name: string, placeholder?: string) => { name: string; value: string };
  aws: {
    Vpc: new (name: string, args?: unknown) => unknown;
    Cluster: new (name: string, args?: unknown) => unknown;
    Bucket: new (name: string, args?: unknown) => { name: string };
    Queue: new (name: string, args?: unknown) => { url: string };
    Postgres: new (
      name: string,
      args?: unknown
    ) => {
      database: string;
      host: string;
      password: string;
      port: number;
      username: string;
    };
    Task: new (name: string, args?: unknown) => unknown;
    Service: new (name: string, args?: unknown) => { url: string };
  };
};

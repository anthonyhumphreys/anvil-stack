export type DeploymentEnvironment = "staging" | "production";

export function deploymentEnvironment(env?: NodeJS.ProcessEnv): DeploymentEnvironment;

export function deploymentVariable(
  name: string,
  legacyName?: string,
  env?: NodeJS.ProcessEnv
): string | undefined;

export function configureWorkosEnvironment(env?: NodeJS.ProcessEnv): void;

export function validateDeploymentEnvironment(env?: NodeJS.ProcessEnv): void;

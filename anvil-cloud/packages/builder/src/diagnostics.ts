export type BuilderPhase =
  | "config"
  | "typecheck"
  | "import-policy"
  | "server-bundle"
  | "manifest"
  | "client-bundle"
  | "generated-client"
  | "build-meta";

export type BuilderDiagnostic = {
  code: string;
  severity: "error" | "warning";
  message: string;
  file?: string;
  line?: number;
  column?: number;
  hint?: string;
};

export type BuildOutput = {
  distDir: string;
  generatedDir: string;
  serverBundle: string;
  clientIndex: string;
  manifest: string;
  buildMeta: string;
  generatedClient: string;
  generatedTypes: string;
};

export type BuildResult = {
  ok: boolean;
  phase?: BuilderPhase;
  diagnostics: BuilderDiagnostic[];
  output?: BuildOutput;
  manifest?: unknown;
};

export function hasErrors(diagnostics: BuilderDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

export function errorDiagnostic(
  diagnostic: Omit<BuilderDiagnostic, "severity">,
): BuilderDiagnostic {
  return {
    ...diagnostic,
    severity: "error",
  };
}

export function warningDiagnostic(
  diagnostic: Omit<BuilderDiagnostic, "severity">,
): BuilderDiagnostic {
  return {
    ...diagnostic,
    severity: "warning",
  };
}

import path from "node:path";

import ts from "typescript";

import { errorDiagnostic, type BuilderDiagnostic } from "./diagnostics.js";

export type TypecheckCellOptions = {
  virtualFiles?: Record<string, string>;
};

export async function typecheckCell(
  rootDir: string,
  options: TypecheckCellOptions = {},
): Promise<BuilderDiagnostic[]> {
  const configPath = ts.findConfigFile(
    rootDir,
    ts.sys.fileExists,
    "tsconfig.json",
  );

  if (!configPath) {
    return [
      errorDiagnostic({
        code: "TSCONFIG_NOT_FOUND",
        message: "Could not find tsconfig.json.",
        file: "tsconfig.json",
      }),
    ];
  }

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);

  if (configFile.error) {
    return [diagnosticFromTs(rootDir, configFile.error)];
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath),
    {
      noEmit: true,
    },
    configPath,
  );

  if (parsed.errors.length > 0) {
    return parsed.errors.map((diagnostic) =>
      diagnosticFromTs(rootDir, diagnostic),
    );
  }

  const host = createCompilerHost(parsed.options, options.virtualFiles ?? {});
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    host,
  });

  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => diagnosticFromTs(rootDir, diagnostic));
}

function createCompilerHost(
  options: ts.CompilerOptions,
  virtualFiles: Record<string, string>,
): ts.CompilerHost {
  const host = ts.createCompilerHost(options);
  const normalizedVirtualFiles = new Map(
    Object.entries(virtualFiles).map(([fileName, source]) => [
      normalizePath(fileName),
      source,
    ]),
  );
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);

  host.fileExists = (fileName) =>
    normalizedVirtualFiles.has(normalizePath(fileName)) || fileExists(fileName);
  host.readFile = (fileName) =>
    normalizedVirtualFiles.get(normalizePath(fileName)) ?? readFile(fileName);
  host.getSourceFile = (
    fileName,
    languageVersionOrOptions,
    onError,
    shouldCreateNewSourceFile,
  ) => {
    const virtualSource = normalizedVirtualFiles.get(normalizePath(fileName));

    if (virtualSource !== undefined) {
      return ts.createSourceFile(
        fileName,
        virtualSource,
        languageVersionOrOptions,
        true,
      );
    }

    return getSourceFile(
      fileName,
      languageVersionOrOptions,
      onError,
      shouldCreateNewSourceFile,
    );
  };

  return host;
}

function normalizePath(fileName: string): string {
  return path.resolve(fileName);
}

function diagnosticFromTs(
  rootDir: string,
  diagnostic: ts.Diagnostic,
): BuilderDiagnostic {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");

  if (diagnostic.file && diagnostic.start !== undefined) {
    const position = diagnostic.file.getLineAndCharacterOfPosition(
      diagnostic.start,
    );

    return errorDiagnostic({
      code: "TYPECHECK_ERROR",
      message,
      file: path.relative(rootDir, diagnostic.file.fileName),
      line: position.line + 1,
      column: position.character + 1,
    });
  }

  return errorDiagnostic({
    code: "TYPECHECK_ERROR",
    message,
  });
}

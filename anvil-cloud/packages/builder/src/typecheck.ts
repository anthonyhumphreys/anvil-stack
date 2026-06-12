import path from "node:path";

import ts from "typescript";

import { errorDiagnostic, type BuilderDiagnostic } from "./diagnostics.js";

export async function typecheckCell(
  rootDir: string,
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

  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
  });

  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => diagnosticFromTs(rootDir, diagnostic));
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

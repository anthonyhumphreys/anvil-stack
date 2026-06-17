import { readFile } from "node:fs/promises";
import path from "node:path";

import ts from "typescript";

import { errorDiagnostic, type BuilderDiagnostic } from "./diagnostics.js";

const sourceExtensions = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

const forbiddenImports = [
  {
    match: (specifier: string) => specifier === "fs" || specifier === "node:fs",
    code: "FORBIDDEN_IMPORT",
    hint: "Use ctx.files for Cell-owned file storage.",
  },
  {
    match: (specifier: string) =>
      specifier === "child_process" || specifier === "node:child_process",
    code: "FORBIDDEN_IMPORT",
    hint: "Move background work into a declared job.",
  },
  {
    match: (specifier: string) => specifier.startsWith("@aws-sdk/"),
    code: "FORBIDDEN_IMPORT",
    hint: "Use declared Anvil capabilities such as ctx.db or ctx.files.",
  },
  {
    match: (specifier: string) =>
      specifier === "aws-cdk-lib" || specifier.startsWith("aws-cdk-lib/"),
    code: "FORBIDDEN_IMPORT",
    hint: "Cell code must not author provider infrastructure directly.",
  },
  {
    match: (specifier: string) =>
      specifier === "sst" || specifier.startsWith("sst/"),
    code: "FORBIDDEN_IMPORT",
    hint: "Provider tooling belongs inside deployment adapters.",
  },
  {
    match: (specifier: string) =>
      specifier === "cdktf" || specifier.startsWith("@cdktf/"),
    code: "FORBIDDEN_IMPORT",
    hint: "Terraform/CDKTF authoring belongs inside deployment adapters.",
  },
  {
    match: (specifier: string) =>
      specifier === "pulumi" || specifier.startsWith("@pulumi/"),
    code: "FORBIDDEN_IMPORT",
    hint: "Provider infrastructure belongs inside deployment adapters.",
  },
];

export type ImportPolicyOptions = {
  rootDir: string;
  serverEntry: string;
};

type PolicyContext = {
  declaredCapabilities: Set<string>;
  outboundFetchAllowList: string[] | null;
  dynamicCapabilities: boolean;
};

export async function checkImportPolicy(
  options: ImportPolicyOptions,
): Promise<BuilderDiagnostic[]> {
  const diagnostics: BuilderDiagnostic[] = [];
  const visited = new Set<string>();
  const policyContext: PolicyContext = {
    declaredCapabilities: new Set(),
    outboundFetchAllowList: null,
    dynamicCapabilities: false,
  };

  await visitModule(
    options.serverEntry,
    options.rootDir,
    visited,
    diagnostics,
    policyContext,
  );

  return diagnostics;
}

async function visitModule(
  filePath: string,
  rootDir: string,
  visited: Set<string>,
  diagnostics: BuilderDiagnostic[],
  policyContext: PolicyContext,
): Promise<void> {
  const resolvedPath = await resolveSourceFile(filePath);

  if (!resolvedPath || visited.has(resolvedPath)) {
    return;
  }

  visited.add(resolvedPath);

  let sourceText: string;

  try {
    sourceText = await readFile(resolvedPath, "utf8");
  } catch {
    diagnostics.push(
      errorDiagnostic({
        code: "SOURCE_READ_FAILED",
        message: `Could not read source file '${path.relative(rootDir, resolvedPath)}'.`,
        file: path.relative(rootDir, resolvedPath),
      }),
    );
    return;
  }

  const sourceFile = ts.createSourceFile(
    resolvedPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(resolvedPath),
  );
  const relativeFile = path.relative(rootDir, resolvedPath);
  const relativeImports: string[] = [];

  collectDeclaredCapabilities(sourceFile, policyContext);

  const inspect = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        inspectImportSpecifier(
          node.moduleSpecifier.text,
          node.moduleSpecifier,
          sourceFile,
          relativeFile,
          diagnostics,
          relativeImports,
        );
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      diagnostics.push(
        diagnosticAt(
          "DYNAMIC_IMPORT_FORBIDDEN",
          "Dynamic import is not allowed in Cell server code.",
          "Keep Cell server dependencies statically inspectable.",
          sourceFile,
          relativeFile,
          node.expression,
        ),
      );
    } else if (isProcessEnvAccess(node)) {
      diagnostics.push(
        diagnosticAt(
          "DIRECT_PROCESS_ENV",
          "Direct process.env access is not allowed in Cell server code.",
          "Use ctx.env.get() or ctx.env.require() inside a handler.",
          sourceFile,
          relativeFile,
          node,
        ),
      );
    } else if (isGlobalFetchCall(node)) {
      inspectOutboundFetchCall(
        node,
        sourceFile,
        relativeFile,
        diagnostics,
        policyContext,
      );
    } else if (isWorkflowDeclaration(node)) {
      inspectCapabilityUse(
        "workflows",
        "workflow",
        "Workflows require capabilities.workflows to be declared.",
        "Declare capabilities.workflows: true before using workflow({ steps }).",
        sourceFile,
        relativeFile,
        node.expression,
        diagnostics,
        policyContext,
      );
    } else if (isServiceDeclaration(node)) {
      inspectCapabilityUse(
        "services",
        "service",
        "Services require capabilities.services to be declared.",
        "Declare capabilities.services: true before using service({ handler }).",
        sourceFile,
        relativeFile,
        node.expression,
        diagnostics,
        policyContext,
      );
    } else if (isScheduledJobDeclaration(node)) {
      inspectCapabilityUse(
        "scheduledJobs",
        "scheduled job",
        "Scheduled jobs require capabilities.scheduledJobs to be declared.",
        "Declare capabilities.scheduledJobs: true before using job({ schedule }).",
        sourceFile,
        relativeFile,
        node.expression,
        diagnostics,
        policyContext,
      );
    } else if (isHandlerProperty(node)) {
      inspectHandlerCapabilities(
        node,
        sourceFile,
        relativeFile,
        diagnostics,
        policyContext,
      );
    }

    ts.forEachChild(node, inspect);
  };

  inspect(sourceFile);

  for (const specifier of relativeImports) {
    const childPath = path.resolve(path.dirname(resolvedPath), specifier);
    await visitModule(childPath, rootDir, visited, diagnostics, policyContext);
  }
}

function inspectImportSpecifier(
  specifier: string,
  node: ts.StringLiteral,
  sourceFile: ts.SourceFile,
  relativeFile: string,
  diagnostics: BuilderDiagnostic[],
  relativeImports: string[],
): void {
  for (const rule of forbiddenImports) {
    if (rule.match(specifier)) {
      diagnostics.push(
        diagnosticAt(
          rule.code,
          `Import '${specifier}' is not allowed in Cell server code.`,
          rule.hint,
          sourceFile,
          relativeFile,
          node,
        ),
      );
    }
  }

  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    relativeImports.push(specifier);
  }
}

function diagnosticAt(
  code: string,
  message: string,
  hint: string,
  sourceFile: ts.SourceFile,
  file: string,
  node: ts.Node,
): BuilderDiagnostic {
  const position = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );

  return errorDiagnostic({
    code,
    message,
    file,
    line: position.line + 1,
    column: position.character + 1,
    hint,
  });
}

function collectDeclaredCapabilities(
  sourceFile: ts.SourceFile,
  policyContext: PolicyContext,
): void {
  const inspect = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      isIdentifierNamed(node.expression, "app")
    ) {
      const [definition] = node.arguments;

      if (definition && ts.isObjectLiteralExpression(definition)) {
        collectCapabilitiesFromAppDefinition(definition, policyContext);
      }
    }

    ts.forEachChild(node, inspect);
  };

  inspect(sourceFile);
}

function collectCapabilitiesFromAppDefinition(
  definition: ts.ObjectLiteralExpression,
  policyContext: PolicyContext,
): void {
  const capabilities = definition.properties.find((property) => {
    return (
      ts.isPropertyAssignment(property) &&
      propertyNameText(property.name) === "capabilities"
    );
  });

  if (!capabilities || !ts.isPropertyAssignment(capabilities)) {
    return;
  }

  if (!ts.isObjectLiteralExpression(capabilities.initializer)) {
    policyContext.dynamicCapabilities = true;
    return;
  }

  for (const property of capabilities.initializer.properties) {
    if (!ts.isPropertyAssignment(property)) {
      policyContext.dynamicCapabilities = true;
      continue;
    }

    const name = propertyNameText(property.name);

    if (!name) {
      policyContext.dynamicCapabilities = true;
      continue;
    }

    if (isCapabilityEnabled(property.initializer)) {
      policyContext.declaredCapabilities.add(name);

      if (name === "outboundFetch") {
        policyContext.outboundFetchAllowList = collectOutboundFetchAllowList(
          property.initializer,
        );
      }
    }
  }
}

function collectOutboundFetchAllowList(node: ts.Expression): string[] | null {
  if (!ts.isObjectLiteralExpression(node)) {
    return null;
  }

  const allow = node.properties.find((property) => {
    return (
      ts.isPropertyAssignment(property) &&
      propertyNameText(property.name) === "allow"
    );
  });

  if (!allow || !ts.isPropertyAssignment(allow)) {
    return null;
  }

  if (!ts.isArrayLiteralExpression(allow.initializer)) {
    return null;
  }

  return allow.initializer.elements
    .filter(ts.isStringLiteral)
    .map((element) => element.text);
}

function inspectHandlerCapabilities(
  handlerProperty: ts.PropertyAssignment | ts.MethodDeclaration,
  sourceFile: ts.SourceFile,
  relativeFile: string,
  diagnostics: BuilderDiagnostic[],
  policyContext: PolicyContext,
): void {
  const handler = ts.isPropertyAssignment(handlerProperty)
    ? handlerProperty.initializer
    : handlerProperty;

  if (!ts.isFunctionLike(handler)) {
    return;
  }

  const [contextParameter] = handler.parameters;

  if (!contextParameter || !ts.isIdentifier(contextParameter.name)) {
    return;
  }

  const contextName = contextParameter.name.text;

  const inspect = (node: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === contextName
    ) {
      inspectContextCapabilityUse(
        node.name.text,
        sourceFile,
        relativeFile,
        node.name,
        diagnostics,
        policyContext,
      );
    }

    ts.forEachChild(node, inspect);
  };

  if (handler.body) {
    inspect(handler.body);
  }
}

function inspectContextCapabilityUse(
  contextProperty: string,
  sourceFile: ts.SourceFile,
  relativeFile: string,
  node: ts.Node,
  diagnostics: BuilderDiagnostic[],
  policyContext: PolicyContext,
): void {
  switch (contextProperty) {
    case "db":
      inspectCapabilityUse(
        "database",
        "ctx.db",
        "ctx.db requires capabilities.database to be declared.",
        "Declare capabilities.database: true before using ctx.db.",
        sourceFile,
        relativeFile,
        node,
        diagnostics,
        policyContext,
      );
      return;
    case "files":
      inspectCapabilityUse(
        "files",
        "ctx.files",
        "ctx.files requires capabilities.files to be declared.",
        "Declare capabilities.files before using ctx.files.",
        sourceFile,
        relativeFile,
        node,
        diagnostics,
        policyContext,
      );
      return;
    case "events":
      inspectCapabilityUse(
        "events",
        "ctx.events",
        "ctx.events requires capabilities.events to be declared.",
        "Declare capabilities.events: true before publishing events.",
        sourceFile,
        relativeFile,
        node,
        diagnostics,
        policyContext,
      );
      return;
    case "workflows":
      inspectCapabilityUse(
        "workflows",
        "ctx.workflows",
        "ctx.workflows requires capabilities.workflows to be declared.",
        "Declare capabilities.workflows: true before starting workflows.",
        sourceFile,
        relativeFile,
        node,
        diagnostics,
        policyContext,
      );
      return;
    case "jobs":
      inspectCapabilityUse(
        "jobs",
        "ctx.jobs",
        "ctx.jobs requires capabilities.jobs to be declared.",
        "Declare capabilities.jobs: true before enqueuing jobs.",
        sourceFile,
        relativeFile,
        node,
        diagnostics,
        policyContext,
      );
      return;
  }
}

function inspectOutboundFetchCall(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  relativeFile: string,
  diagnostics: BuilderDiagnostic[],
  policyContext: PolicyContext,
): void {
  inspectCapabilityUse(
    "outboundFetch",
    "fetch",
    "Global fetch requires capabilities.outboundFetch to be declared.",
    "Declare capabilities.outboundFetch with an allow list for external domains.",
    sourceFile,
    relativeFile,
    node.expression,
    diagnostics,
    policyContext,
  );

  if (
    policyContext.dynamicCapabilities ||
    !policyContext.declaredCapabilities.has("outboundFetch")
  ) {
    return;
  }

  const [target] = node.arguments;
  const host = target ? fetchHostFromLiteral(target) : null;

  if (!target || !host) {
    diagnostics.push(
      diagnosticAt(
        "OUTBOUND_FETCH_TARGET_NOT_STATIC",
        "Fetch target must be a static absolute http(s) URL in Cell server code.",
        "Use a literal URL whose host appears in capabilities.outboundFetch.allow.",
        sourceFile,
        relativeFile,
        node.expression,
      ),
    );
    return;
  }

  if (
    !policyContext.outboundFetchAllowList ||
    policyContext.outboundFetchAllowList.includes(host)
  ) {
    return;
  }

  diagnostics.push(
    diagnosticAt(
      "OUTBOUND_FETCH_NOT_ALLOWED",
      `Fetch host '${host}' is not declared in capabilities.outboundFetch.allow.`,
      "Add the host to capabilities.outboundFetch.allow or route the call through a declared platform capability.",
      sourceFile,
      relativeFile,
      target,
    ),
  );
}

function inspectCapabilityUse(
  capability: string,
  subject: string,
  message: string,
  hint: string,
  sourceFile: ts.SourceFile,
  relativeFile: string,
  node: ts.Node,
  diagnostics: BuilderDiagnostic[],
  policyContext: PolicyContext,
): void {
  if (
    policyContext.dynamicCapabilities ||
    policyContext.declaredCapabilities.has(capability)
  ) {
    return;
  }

  diagnostics.push(
    diagnosticAt(
      "CAPABILITY_NOT_DECLARED",
      message,
      `${hint} ${subject} is capability-scoped Cell code.`,
      sourceFile,
      relativeFile,
      node,
    ),
  );
}

function isProcessEnvAccess(node: ts.Node): boolean {
  if (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "env" &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "process"
  ) {
    return true;
  }

  return (
    ts.isElementAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "process" &&
    ts.isStringLiteral(node.argumentExpression) &&
    node.argumentExpression.text === "env"
  );
}

function isGlobalFetchCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) && isIdentifierNamed(node.expression, "fetch")
  );
}

function fetchHostFromLiteral(node: ts.Expression): string | null {
  if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) {
    return null;
  }

  try {
    const url = new URL(node.text);

    return url.protocol === "http:" || url.protocol === "https:"
      ? url.host
      : null;
  } catch {
    return null;
  }
}

function isWorkflowDeclaration(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) && isIdentifierNamed(node.expression, "workflow")
  );
}

function isServiceDeclaration(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) && isIdentifierNamed(node.expression, "service")
  );
}

function isScheduledJobDeclaration(node: ts.Node): node is ts.CallExpression {
  if (
    !ts.isCallExpression(node) ||
    !isIdentifierNamed(node.expression, "job")
  ) {
    return false;
  }

  const [definition] = node.arguments;

  return (
    definition !== undefined &&
    ts.isObjectLiteralExpression(definition) &&
    definition.properties.some((property) => {
      return (
        ts.isPropertyAssignment(property) &&
        propertyNameText(property.name) === "schedule"
      );
    })
  );
}

function isHandlerProperty(
  node: ts.Node,
): node is ts.PropertyAssignment | ts.MethodDeclaration {
  return (
    ((ts.isPropertyAssignment(node) && ts.isFunctionLike(node.initializer)) ||
      ts.isMethodDeclaration(node)) &&
    propertyNameText(node.name) === "handler"
  );
}

function isIdentifierNamed(
  node: ts.Expression,
  name: string,
): node is ts.Identifier {
  return ts.isIdentifier(node) && node.text === name;
}

function isCapabilityEnabled(node: ts.Expression): boolean {
  return (
    node.kind === ts.SyntaxKind.TrueKeyword ||
    ts.isObjectLiteralExpression(node) ||
    ts.isArrayLiteralExpression(node)
  );
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text;
  }

  return null;
}

async function resolveSourceFile(filePath: string): Promise<string | null> {
  const direct = await existingFile(filePath);

  if (direct) {
    return direct;
  }

  for (const extension of sourceExtensions) {
    const withExtension = await existingFile(`${filePath}${extension}`);

    if (withExtension) {
      return withExtension;
    }
  }

  for (const extension of sourceExtensions) {
    const indexFile = await existingFile(
      path.join(filePath, `index${extension}`),
    );

    if (indexFile) {
      return indexFile;
    }
  }

  return null;
}

async function existingFile(filePath: string): Promise<string | null> {
  try {
    const text = await readFile(filePath, "utf8");

    return text.length >= 0 ? filePath : null;
  } catch {
    return null;
  }
}

function scriptKindFor(filePath: string): ts.ScriptKind {
  if (filePath.endsWith(".tsx") || filePath.endsWith(".jsx")) {
    return ts.ScriptKind.TSX;
  }

  return ts.ScriptKind.TS;
}

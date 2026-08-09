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
    match: (specifier: string) =>
      specifier === "fs" ||
      specifier.startsWith("fs/") ||
      specifier === "node:fs" ||
      specifier.startsWith("node:fs/"),
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
    match: (specifier: string) =>
      [
        "axios",
        "got",
        "node-fetch",
        "undici",
        "ws",
        "http",
        "https",
        "http2",
        "net",
        "tls",
        "dns",
        "dgram",
        "node:http",
        "node:https",
        "node:http2",
        "node:net",
        "node:tls",
        "node:dns",
        "node:dgram",
      ].includes(specifier),
    code: "FORBIDDEN_NETWORK_IMPORT",
    hint: "Use global fetch with capabilities.outboundFetch so outbound domains stay declarative.",
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
  declaredEnvNames: Set<string>;
  outboundFetchAllowList: string[] | null;
  dynamicCapabilities: boolean;
  dynamicEnvDeclarations: boolean;
};

export async function checkImportPolicy(
  options: ImportPolicyOptions,
): Promise<BuilderDiagnostic[]> {
  const diagnostics: BuilderDiagnostic[] = [];
  const visited = new Set<string>();
  const policyContext: PolicyContext = {
    declaredCapabilities: new Set(),
    declaredEnvNames: new Set(),
    outboundFetchAllowList: null,
    dynamicCapabilities: false,
    dynamicEnvDeclarations: false,
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
  const processAliases = new Set(["process"]);
  const processEnvAliases = new Set<string>();
  const fetchAliases = new Set(["fetch"]);

  collectDeclaredCapabilities(sourceFile, policyContext);

  const inspect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node)) {
      inspectProcessAliasDeclaration(
        node,
        sourceFile,
        relativeFile,
        diagnostics,
        processAliases,
        processEnvAliases,
      );
      inspectFetchAliasDeclaration(node, fetchAliases);
    }

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
    } else if (isCreateRequireCall(node)) {
      diagnostics.push(
        diagnosticAt(
          "CREATE_REQUIRE_FORBIDDEN",
          "createRequire() is not allowed in Cell server code.",
          "Keep Cell server dependencies statically inspectable with normal import declarations.",
          sourceFile,
          relativeFile,
          node.expression,
        ),
      );
    } else if (isCommonJsRequireCall(node)) {
      const requireSpecifier = commonJsRequireSpecifier(node);

      if (!requireSpecifier) {
        return;
      }

      inspectImportSpecifier(
        requireSpecifier.text,
        requireSpecifier,
        sourceFile,
        relativeFile,
        diagnostics,
        relativeImports,
      );
    } else if (isProcessEnvAccess(node, processAliases, processEnvAliases)) {
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
    } else if (isGlobalFetchCall(node, fetchAliases)) {
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
  node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral,
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
      } else if (name === "env" || name === "secrets") {
        const envNames = collectDeclaredEnvNames(property.initializer);

        if (envNames) {
          for (const envName of envNames) {
            policyContext.declaredEnvNames.add(envName);
          }
        } else {
          policyContext.dynamicEnvDeclarations = true;
        }
      }
    }
  }
}

function inspectProcessAliasDeclaration(
  node: ts.VariableDeclaration,
  sourceFile: ts.SourceFile,
  relativeFile: string,
  diagnostics: BuilderDiagnostic[],
  processAliases: Set<string>,
  processEnvAliases: Set<string>,
): void {
  if (!node.initializer) {
    return;
  }

  if (
    ts.isIdentifier(node.name) &&
    isProcessReference(node.initializer, processAliases)
  ) {
    processAliases.add(node.name.text);
    return;
  }

  if (
    ts.isIdentifier(node.name) &&
    isProcessEnvReference(node.initializer, processAliases)
  ) {
    processEnvAliases.add(node.name.text);
    return;
  }

  if (
    !ts.isObjectBindingPattern(node.name) ||
    !isProcessReference(node.initializer, processAliases)
  ) {
    return;
  }

  for (const element of node.name.elements) {
    if (element.dotDotDotToken || !ts.isIdentifier(element.name)) {
      continue;
    }

    const propertyName = element.propertyName
      ? bindingPropertyNameText(element.propertyName)
      : element.name.text;

    if (propertyName !== "env") {
      continue;
    }

    processEnvAliases.add(element.name.text);
    diagnostics.push(
      diagnosticAt(
        "DIRECT_PROCESS_ENV",
        "Direct process.env access is not allowed in Cell server code.",
        "Use ctx.env.get() or ctx.env.require() inside a handler.",
        sourceFile,
        relativeFile,
        element.name,
      ),
    );
  }
}

function inspectFetchAliasDeclaration(
  node: ts.VariableDeclaration,
  fetchAliases: Set<string>,
): void {
  if (!node.initializer) {
    return;
  }

  if (
    ts.isIdentifier(node.name) &&
    isFetchReference(node.initializer, fetchAliases)
  ) {
    fetchAliases.add(node.name.text);
    return;
  }

  if (
    !ts.isObjectBindingPattern(node.name) ||
    !isIdentifierNamed(node.initializer, "globalThis")
  ) {
    return;
  }

  for (const element of node.name.elements) {
    if (element.dotDotDotToken || !ts.isIdentifier(element.name)) {
      continue;
    }

    const propertyName = element.propertyName
      ? bindingPropertyNameText(element.propertyName)
      : element.name.text;

    if (propertyName === "fetch") {
      fetchAliases.add(element.name.text);
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

function collectDeclaredEnvNames(node: ts.Expression): string[] | null {
  if (ts.isArrayLiteralExpression(node)) {
    const names: string[] = [];

    for (const element of node.elements) {
      if (!ts.isStringLiteral(element)) {
        return null;
      }

      names.push(element.text);
    }

    return names;
  }

  if (ts.isObjectLiteralExpression(node)) {
    const names: string[] = [];

    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) {
        return null;
      }

      const name = propertyNameText(property.name);

      if (!name) {
        return null;
      }

      names.push(name);
    }

    return names;
  }

  return null;
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

  if (
    !contextParameter ||
    (!ts.isIdentifier(contextParameter.name) &&
      !ts.isObjectBindingPattern(contextParameter.name))
  ) {
    return;
  }

  const contextName = ts.isIdentifier(contextParameter.name)
    ? contextParameter.name.text
    : "__anvil_context_parameter__";
  const contextEnvAliases = new Set<string>();
  const contextEnvMethodAliases = new Map<string, "get" | "require">();

  if (ts.isObjectBindingPattern(contextParameter.name)) {
    inspectContextBindingPattern(
      contextParameter.name,
      sourceFile,
      relativeFile,
      diagnostics,
      policyContext,
      contextEnvAliases,
    );
  }

  const inspect = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(contextParameter.name)
    ) {
      inspectContextAliasDeclaration(
        node,
        contextName,
        sourceFile,
        relativeFile,
        diagnostics,
        policyContext,
        contextEnvAliases,
        contextEnvMethodAliases,
      );
    }

    const contextProperty = contextAccessPropertyName(node, contextName);

    if (contextProperty) {
      inspectContextCapabilityUse(
        contextProperty.name,
        sourceFile,
        relativeFile,
        contextProperty.node,
        diagnostics,
        policyContext,
      );
    } else if (isDynamicContextAccess(node, contextName)) {
      diagnostics.push(
        diagnosticAt(
          "CTX_PROPERTY_NOT_STATIC",
          "Context capability access must use a static property name in Cell server code.",
          "Use ctx.db, ctx.files, ctx.env, or static bracket notation so Guard can verify declared capabilities.",
          sourceFile,
          relativeFile,
          node.argumentExpression,
        ),
      );
    } else if (
      isDynamicContextEnvMethodRead(node, contextName, contextEnvAliases)
    ) {
      diagnostics.push(
        diagnosticAt(
          "ENV_METHOD_NOT_STATIC",
          "ctx.env method access must use get or require statically in Cell server code.",
          "Use ctx.env.get('NAME') or ctx.env.require('NAME') so Guard can verify env declarations.",
          sourceFile,
          relativeFile,
          node.expression.argumentExpression,
        ),
      );
    } else if (isContextEnvRead(node, contextName, contextEnvAliases)) {
      inspectEnvDeclarationUse(
        node,
        sourceFile,
        relativeFile,
        diagnostics,
        policyContext,
      );
    } else if (isContextEnvMethodAliasRead(node, contextEnvMethodAliases)) {
      inspectEnvDeclarationUse(
        node,
        sourceFile,
        relativeFile,
        diagnostics,
        policyContext,
        contextEnvMethodAliases.get(node.expression.text),
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

function contextAccessPropertyName(
  node: ts.Node,
  contextName: string,
): { name: string; node: ts.Node } | null {
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === contextName
  ) {
    return { name: node.name.text, node: node.name };
  }

  if (
    ts.isElementAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === contextName &&
    (ts.isStringLiteral(node.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))
  ) {
    return {
      name: node.argumentExpression.text,
      node: node.argumentExpression,
    };
  }

  return null;
}

function isDynamicContextAccess(
  node: ts.Node,
  contextName: string,
): node is ts.ElementAccessExpression {
  return (
    ts.isElementAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === contextName &&
    !ts.isStringLiteral(node.argumentExpression) &&
    !ts.isNoSubstitutionTemplateLiteral(node.argumentExpression)
  );
}

function inspectContextAliasDeclaration(
  node: ts.VariableDeclaration,
  contextName: string,
  sourceFile: ts.SourceFile,
  relativeFile: string,
  diagnostics: BuilderDiagnostic[],
  policyContext: PolicyContext,
  contextEnvAliases: Set<string>,
  contextEnvMethodAliases: Map<string, "get" | "require">,
): void {
  if (!node.initializer) {
    return;
  }

  const initializerContextProperty = contextAccessPropertyName(
    node.initializer,
    contextName,
  );

  if (
    initializerContextProperty?.name === "env" &&
    ts.isIdentifier(node.name)
  ) {
    contextEnvAliases.add(node.name.text);
    return;
  }

  const initializerEnvMethod = contextEnvMethodName(
    node.initializer,
    contextName,
    contextEnvAliases,
  );

  if (initializerEnvMethod && ts.isIdentifier(node.name)) {
    contextEnvMethodAliases.set(node.name.text, initializerEnvMethod);
    return;
  }

  if (
    isDynamicContextEnvMethodAccess(
      node.initializer,
      contextName,
      contextEnvAliases,
    )
  ) {
    diagnostics.push(
      diagnosticAt(
        "ENV_METHOD_NOT_STATIC",
        "ctx.env method access must use get or require statically in Cell server code.",
        "Use ctx.env.get('NAME') or ctx.env.require('NAME') so Guard can verify env declarations.",
        sourceFile,
        relativeFile,
        node.initializer.argumentExpression,
      ),
    );
    return;
  }

  if (
    ts.isObjectBindingPattern(node.name) &&
    isContextEnvValue(node.initializer, contextName, contextEnvAliases)
  ) {
    inspectContextEnvBindingPattern(
      node.name,
      sourceFile,
      relativeFile,
      diagnostics,
      contextEnvMethodAliases,
    );
    return;
  }

  if (
    !ts.isObjectBindingPattern(node.name) ||
    !ts.isIdentifier(node.initializer) ||
    node.initializer.text !== contextName
  ) {
    return;
  }

  inspectContextBindingPattern(
    node.name,
    sourceFile,
    relativeFile,
    diagnostics,
    policyContext,
    contextEnvAliases,
  );
}

function inspectContextBindingPattern(
  binding: ts.ObjectBindingPattern,
  sourceFile: ts.SourceFile,
  relativeFile: string,
  diagnostics: BuilderDiagnostic[],
  policyContext: PolicyContext,
  contextEnvAliases: Set<string>,
): void {
  for (const element of binding.elements) {
    if (element.dotDotDotToken || !ts.isIdentifier(element.name)) {
      diagnostics.push(
        diagnosticAt(
          "CTX_BINDING_NOT_STATIC",
          "Context destructuring must use static named properties in Cell server code.",
          "Use ctx.db, ctx.files, ctx.env, or simple destructuring such as const { db } = ctx so Guard can verify declared capabilities.",
          sourceFile,
          relativeFile,
          element.name,
        ),
      );
      continue;
    }

    const propertyName = element.propertyName
      ? bindingPropertyNameText(element.propertyName)
      : element.name.text;

    if (!propertyName) {
      diagnostics.push(
        diagnosticAt(
          "CTX_BINDING_NOT_STATIC",
          "Context destructuring must use static named properties in Cell server code.",
          "Use ctx.db, ctx.files, ctx.env, or simple destructuring such as const { db } = ctx so Guard can verify declared capabilities.",
          sourceFile,
          relativeFile,
          element.name,
        ),
      );
      continue;
    }

    if (propertyName === "env") {
      contextEnvAliases.add(element.name.text);
    }

    inspectContextCapabilityUse(
      propertyName,
      sourceFile,
      relativeFile,
      element.name,
      diagnostics,
      policyContext,
    );
  }
}

function inspectContextEnvBindingPattern(
  binding: ts.ObjectBindingPattern,
  sourceFile: ts.SourceFile,
  relativeFile: string,
  diagnostics: BuilderDiagnostic[],
  contextEnvMethodAliases: Map<string, "get" | "require">,
): void {
  for (const element of binding.elements) {
    if (element.dotDotDotToken || !ts.isIdentifier(element.name)) {
      diagnostics.push(
        diagnosticAt(
          "ENV_METHOD_NOT_STATIC",
          "ctx.env method destructuring must use get or require statically in Cell server code.",
          "Use const { get } = ctx.env or const { require } = ctx.env so Guard can verify env declarations.",
          sourceFile,
          relativeFile,
          element.name,
        ),
      );
      continue;
    }

    const propertyName = element.propertyName
      ? bindingPropertyNameText(element.propertyName)
      : element.name.text;

    if (!propertyName) {
      diagnostics.push(
        diagnosticAt(
          "ENV_METHOD_NOT_STATIC",
          "ctx.env method destructuring must use get or require statically in Cell server code.",
          "Use const { get } = ctx.env or const { require } = ctx.env so Guard can verify env declarations.",
          sourceFile,
          relativeFile,
          element.name,
        ),
      );
      continue;
    }

    if (propertyName === "get" || propertyName === "require") {
      contextEnvMethodAliases.set(element.name.text, propertyName);
    }
  }
}

function inspectEnvDeclarationUse(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  relativeFile: string,
  diagnostics: BuilderDiagnostic[],
  policyContext: PolicyContext,
  methodOverride?: "get" | "require",
): void {
  if (
    policyContext.dynamicCapabilities ||
    policyContext.dynamicEnvDeclarations
  ) {
    return;
  }

  const method = methodOverride ?? envReadMethod(node);
  const [nameArgument] = node.arguments;

  if (
    method === null ||
    !nameArgument ||
    (!ts.isStringLiteral(nameArgument) &&
      !ts.isNoSubstitutionTemplateLiteral(nameArgument))
  ) {
    diagnostics.push(
      diagnosticAt(
        "ENV_NAME_NOT_STATIC",
        "ctx.env names must be static string literals in Cell server code.",
        "Use ctx.env.get('NAME') or ctx.env.require('NAME') with a name declared in capabilities.env or capabilities.secrets.",
        sourceFile,
        relativeFile,
        node.expression,
      ),
    );
    return;
  }

  if (policyContext.declaredEnvNames.has(nameArgument.text)) {
    return;
  }

  diagnostics.push(
    diagnosticAt(
      "ENV_NOT_DECLARED",
      `ctx.env.${method}('${nameArgument.text}') requires '${nameArgument.text}' to be declared in capabilities.env or capabilities.secrets.`,
      "Declare the env name before reading it so adapters can plan configuration and secret access.",
      sourceFile,
      relativeFile,
      nameArgument,
    ),
  );
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
  const host = target ? fetchHostFromStaticTarget(target) : null;

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

function isProcessEnvAccess(
  node: ts.Node,
  processAliases: Set<string>,
  processEnvAliases: Set<string>,
): boolean {
  if (isProcessEnvReference(node, processAliases)) {
    return true;
  }

  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    processEnvAliases.has(node.expression.text)
  ) {
    return true;
  }

  return (
    ts.isElementAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    processEnvAliases.has(node.expression.text)
  );
}

function isProcessEnvReference(
  node: ts.Node,
  processAliases: Set<string>,
): boolean {
  if (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "env" &&
    isProcessReference(node.expression, processAliases)
  ) {
    return true;
  }

  return (
    ts.isElementAccessExpression(node) &&
    isProcessReference(node.expression, processAliases) &&
    ts.isStringLiteral(node.argumentExpression) &&
    node.argumentExpression.text === "env"
  );
}

function isProcessReference(
  node: ts.Node,
  processAliases: Set<string>,
): boolean {
  if (ts.isIdentifier(node)) {
    return processAliases.has(node.text);
  }

  if (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "process" &&
    isIdentifierNamed(node.expression, "globalThis")
  ) {
    return true;
  }

  return (
    ts.isElementAccessExpression(node) &&
    isIdentifierNamed(node.expression, "globalThis") &&
    ts.isStringLiteral(node.argumentExpression) &&
    node.argumentExpression.text === "process"
  );
}

function isGlobalFetchCall(
  node: ts.Node,
  fetchAliases: Set<string>,
): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) && isFetchReference(node.expression, fetchAliases)
  );
}

function isFetchReference(
  node: ts.Node,
  fetchAliases: Set<string>,
): node is ts.Expression {
  if (ts.isIdentifier(node)) {
    return fetchAliases.has(node.text);
  }

  if (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "fetch" &&
    isIdentifierNamed(node.expression, "globalThis")
  ) {
    return true;
  }

  return (
    ts.isElementAccessExpression(node) &&
    isIdentifierNamed(node.expression, "globalThis") &&
    ts.isStringLiteral(node.argumentExpression) &&
    node.argumentExpression.text === "fetch"
  );
}

function commonJsRequireSpecifier(
  node: ts.CallExpression,
): ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | null {
  if (!isIdentifierNamed(node.expression, "require")) {
    return null;
  }

  const [specifier] = node.arguments;

  if (
    specifier &&
    (ts.isStringLiteral(specifier) ||
      ts.isNoSubstitutionTemplateLiteral(specifier))
  ) {
    return specifier;
  }

  return null;
}

function isCommonJsRequireCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && commonJsRequireSpecifier(node) !== null;
}

function isCreateRequireCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    isIdentifierNamed(node.expression, "createRequire")
  );
}

function isContextEnvRead(
  node: ts.Node,
  contextName: string,
  contextEnvAliases: Set<string>,
): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) {
    return false;
  }

  return (
    envReadMethod(node) !== null &&
    isStaticPropertyAccessExpression(node.expression) &&
    isContextEnvExpression(node.expression, contextName, contextEnvAliases)
  );
}

function isContextEnvMethodAliasRead(
  node: ts.Node,
  contextEnvMethodAliases: Map<string, "get" | "require">,
): node is ts.CallExpression & { expression: ts.Identifier } {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    contextEnvMethodAliases.has(node.expression.text)
  );
}

function isDynamicContextEnvMethodRead(
  node: ts.Node,
  contextName: string,
  contextEnvAliases: Set<string>,
): node is ts.CallExpression & { expression: ts.ElementAccessExpression } {
  return (
    ts.isCallExpression(node) &&
    isDynamicContextEnvMethodAccess(
      node.expression,
      contextName,
      contextEnvAliases,
    )
  );
}

function isDynamicContextEnvMethodAccess(
  node: ts.Node,
  contextName: string,
  contextEnvAliases: Set<string>,
): node is ts.ElementAccessExpression {
  return (
    ts.isElementAccessExpression(node) &&
    !ts.isStringLiteral(node.argumentExpression) &&
    !ts.isNoSubstitutionTemplateLiteral(node.argumentExpression) &&
    isContextEnvValue(node.expression, contextName, contextEnvAliases)
  );
}

function envReadMethod(node: ts.CallExpression): "get" | "require" | null {
  if (!isStaticPropertyAccessExpression(node.expression)) {
    return null;
  }

  const name = staticAccessPropertyName(node.expression);

  if (name === "get") {
    return "get";
  }

  if (name === "require") {
    return "require";
  }

  return null;
}

function contextEnvMethodName(
  node: ts.Node,
  contextName: string,
  contextEnvAliases: Set<string>,
): "get" | "require" | null {
  if (
    isStaticPropertyAccessExpression(node) &&
    isContextEnvValue(node.expression, contextName, contextEnvAliases)
  ) {
    const name = staticAccessPropertyName(node);

    if (name === "get" || name === "require") {
      return name;
    }
  }

  return null;
}

function isContextEnvValue(
  node: ts.Node,
  contextName: string,
  contextEnvAliases: Set<string>,
): boolean {
  if (contextAccessPropertyName(node, contextName)?.name === "env") {
    return true;
  }

  return ts.isIdentifier(node) && contextEnvAliases.has(node.text);
}

function isContextEnvExpression(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  contextName: string,
  contextEnvAliases: Set<string>,
): boolean {
  return isContextEnvValue(node.expression, contextName, contextEnvAliases);
}

function isStaticPropertyAccessExpression(
  node: ts.Node,
): node is ts.PropertyAccessExpression | ts.ElementAccessExpression {
  return (
    ts.isPropertyAccessExpression(node) ||
    (ts.isElementAccessExpression(node) &&
      (ts.isStringLiteral(node.argumentExpression) ||
        ts.isNoSubstitutionTemplateLiteral(node.argumentExpression)))
  );
}

function staticAccessPropertyName(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | null {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }

  if (
    ts.isStringLiteral(node.argumentExpression) ||
    ts.isNoSubstitutionTemplateLiteral(node.argumentExpression)
  ) {
    return node.argumentExpression.text;
  }

  return null;
}

function fetchHostFromStaticTarget(node: ts.Expression): string | null {
  const text = staticUrlText(node);

  try {
    const url = new URL(text);

    return url.protocol === "http:" || url.protocol === "https:"
      ? url.host
      : null;
  } catch {
    return null;
  }
}

function staticUrlText(node: ts.Expression): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }

  if (
    ts.isNewExpression(node) &&
    isIdentifierNamed(node.expression, "URL") &&
    node.arguments?.length === 1
  ) {
    const [urlArgument] = node.arguments;

    if (
      urlArgument &&
      (ts.isStringLiteral(urlArgument) ||
        ts.isNoSubstitutionTemplateLiteral(urlArgument))
    ) {
      return urlArgument.text;
    }
  }

  return "";
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

function bindingPropertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text;
  }

  if (ts.isNumericLiteral(name)) {
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

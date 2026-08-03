import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type {
  ModuleSummary,
  RepositoryMapGraph,
  RepositoryMapGraphEdge,
  RepositoryMapGraphNode,
  RepositoryMapSymbolKind,
  RepositorySourceRange,
} from '../../shared/types.js';
import type { FileEntry } from '../utils/file-walker.js';

const GRAPH_SCHEMA_VERSION = 1 as const;
const MAX_SYMBOL_FILE_BYTES = 750_000;
const MAX_SYMBOLS_PER_FILE = 300;
export const REPOSITORY_MAP_GRAPH_LIMITS = {
  nodes: 20_000,
  edges: 40_000,
  symbols: 12_000,
  parsedSourceBytes: 50_000_000,
} as const;
const SYMBOL_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

interface BuildRepositoryMapGraphInput {
  repoId: string;
  repositoryName: string;
  repoPath: string;
  indexedCommitSha?: string;
  files: FileEntry[];
  modules: ModuleSummary[];
}

interface ExtractedSymbol {
  name: string;
  kind: RepositoryMapSymbolKind;
  range: RepositorySourceRange;
  exported: boolean;
}

interface ParsedSourceFile {
  imports: string[];
  symbols: ExtractedSymbol[];
}

export function buildRepositoryMapGraph({
  repoId,
  repositoryName,
  repoPath,
  indexedCommitSha,
  files,
  modules,
}: BuildRepositoryMapGraphInput): RepositoryMapGraph {
  const nodes = new Map<string, RepositoryMapGraphNode>();
  const edges = new Map<string, RepositoryMapGraphEdge>();
  const warnings = new Set<string>();
  const parsedFiles = new Map<string, ParsedSourceFile>();
  const normalizedFiles = new Set<string>();
  const rootId = repositoryNodeId(repoId);

  nodes.set(rootId, {
    id: rootId,
    kind: 'repository',
    name: repositoryName,
    path: '.',
    fileCount: files.length,
  });

  for (const module of modules) {
    const modulePath = normalizeModulePath(module.path);
    const moduleId = moduleNodeId(modulePath);
    nodes.set(moduleId, {
      id: moduleId,
      kind: 'module',
      parentId: rootId,
      name: modulePath === '.' ? 'Repository root' : path.posix.basename(modulePath),
      path: modulePath,
      modulePath,
      purpose: module.purpose,
      fileCount: module.fileCount,
    });
    addEdge(edges, 'contains', rootId, moduleId);
  }

  if (modules.length === 0) {
    nodes.set(moduleNodeId('.'), {
      id: moduleNodeId('.'),
      kind: 'module',
      parentId: rootId,
      name: 'Repository root',
      path: '.',
      modulePath: '.',
      purpose: 'Repository files',
      fileCount: files.length,
    });
    addEdge(edges, 'contains', rootId, moduleNodeId('.'));
  }

  const indexedFiles: FileEntry[] = [];
  for (const file of files.toSorted((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    if (nodes.size >= REPOSITORY_MAP_GRAPH_LIMITS.nodes) {
      warnings.add(
        `Limited repository map to ${REPOSITORY_MAP_GRAPH_LIMITS.nodes.toLocaleString()} nodes; some files and symbols were omitted.`,
      );
      break;
    }
    const filePath = normalizePath(file.relativePath);
    const modulePath = findModulePath(modules, filePath);
    const moduleId = moduleNodeId(modulePath);
    const parentId = ensureDirectoryNodes(nodes, edges, modulePath, filePath, moduleId);
    if (!parentId || nodes.size >= REPOSITORY_MAP_GRAPH_LIMITS.nodes) {
      warnings.add(
        `Limited repository map to ${REPOSITORY_MAP_GRAPH_LIMITS.nodes.toLocaleString()} nodes; some files and symbols were omitted.`,
      );
      break;
    }
    const fileId = fileNodeId(filePath);
    const language = languageForExtension(file.extension);

    nodes.set(fileId, {
      id: fileId,
      kind: 'file',
      parentId,
      name: path.posix.basename(filePath),
      path: filePath,
      modulePath,
      language,
    });
    addEdge(edges, 'contains', parentId, fileId);
    normalizedFiles.add(filePath);
    indexedFiles.push(file);
  }

  let parsedSourceBytes = 0;
  let symbolNodeCount = 0;
  for (const file of indexedFiles) {
    const filePath = normalizePath(file.relativePath);
    const fileId = fileNodeId(filePath);
    const modulePath = nodes.get(fileId)?.modulePath ?? '.';
    const language = languageForExtension(file.extension);
    if (!SYMBOL_EXTENSIONS.has(file.extension)) continue;
    if (file.sizeBytes > MAX_SYMBOL_FILE_BYTES) {
      warnings.add(
        `Skipped symbol extraction for files larger than ${Math.round(MAX_SYMBOL_FILE_BYTES / 1000)} KB.`,
      );
      continue;
    }
    if (
      parsedSourceBytes + file.sizeBytes >
      REPOSITORY_MAP_GRAPH_LIMITS.parsedSourceBytes
    ) {
      warnings.add(
        `Limited source inspection to ${Math.round(REPOSITORY_MAP_GRAPH_LIMITS.parsedSourceBytes / 1_000_000)} MB.`,
      );
      continue;
    }

    try {
      parsedSourceBytes += file.sizeBytes;
      const source = fs.readFileSync(path.join(repoPath, filePath), 'utf8');
      const parsed = parseSourceFile(filePath, source);
      parsedFiles.set(filePath, parsed);
      const availableSymbols = Math.max(
        0,
        Math.min(
          MAX_SYMBOLS_PER_FILE,
          REPOSITORY_MAP_GRAPH_LIMITS.symbols - symbolNodeCount,
          REPOSITORY_MAP_GRAPH_LIMITS.nodes - nodes.size,
        ),
      );
      if (parsed.symbols.length > MAX_SYMBOLS_PER_FILE) {
        warnings.add(`Limited symbol extraction to ${MAX_SYMBOLS_PER_FILE} symbols per file.`);
      }
      if (parsed.symbols.length > availableSymbols) {
        warnings.add(
          `Limited repository map to ${REPOSITORY_MAP_GRAPH_LIMITS.symbols.toLocaleString()} symbol nodes.`,
        );
      }
      const visibleSymbols = parsed.symbols.slice(0, availableSymbols);
      const fileNode = nodes.get(fileId);
      if (fileNode) fileNode.symbolCount = visibleSymbols.length;
      symbolNodeCount += visibleSymbols.length;

      visibleSymbols.forEach((symbol, index) => {
        const symbolId = symbolNodeId(filePath, symbol, index);
        nodes.set(symbolId, {
          id: symbolId,
          kind: 'symbol',
          parentId: fileId,
          name: symbol.name,
          path: filePath,
          modulePath,
          language,
          sourceRange: symbol.range,
          symbolKind: symbol.kind,
          exported: symbol.exported,
        });
        addEdge(edges, 'contains', fileId, symbolId);
      });
    } catch (error) {
      warnings.add(
        `Some TypeScript or JavaScript files could not be inspected: ${shortErrorMessage(error)}`,
      );
    }
  }

  const moduleDependencies = new Map<string, number>();
  for (const [sourcePath, parsed] of parsedFiles) {
    for (const importPath of parsed.imports) {
      const targetPath = resolveInternalImport(sourcePath, importPath, normalizedFiles);
      if (!targetPath || targetPath === sourcePath) continue;
      addEdge(edges, 'dependency', fileNodeId(sourcePath), fileNodeId(targetPath));

      const sourceModule = nodes.get(fileNodeId(sourcePath))?.modulePath ?? '.';
      const targetModule = nodes.get(fileNodeId(targetPath))?.modulePath ?? '.';
      if (sourceModule === targetModule) continue;
      const key = `${sourceModule}\0${targetModule}`;
      moduleDependencies.set(key, (moduleDependencies.get(key) ?? 0) + 1);
    }
  }

  for (const [key, count] of moduleDependencies) {
    const [sourceModule, targetModule] = key.split('\0');
    addEdge(edges, 'dependency', moduleNodeId(sourceModule), moduleNodeId(targetModule), count);
  }

  if (edges.size >= REPOSITORY_MAP_GRAPH_LIMITS.edges) {
    warnings.add(
      `Limited repository map to ${REPOSITORY_MAP_GRAPH_LIMITS.edges.toLocaleString()} relationships.`,
    );
  }

  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    repoId,
    repositoryName,
    indexedCommitSha,
    generatedAt: new Date().toISOString(),
    nodes: [...nodes.values()].toSorted(compareGraphNodes),
    edges: [...edges.values()].toSorted((a, b) => a.id.localeCompare(b.id)),
    supportedSymbolLanguages: ['TypeScript', 'JavaScript'],
    warnings: [...warnings],
  };
}

function ensureDirectoryNodes(
  nodes: Map<string, RepositoryMapGraphNode>,
  edges: Map<string, RepositoryMapGraphEdge>,
  modulePath: string,
  filePath: string,
  moduleId: string,
): string | null {
  const directory = path.posix.dirname(filePath);
  if (directory === '.') return moduleId;

  const directoryParts = directory.split('/');
  const moduleDepth = modulePath === '.' ? 0 : modulePath.split('/').length;
  let parentId = moduleId;

  for (let depth = moduleDepth + 1; depth <= directoryParts.length; depth += 1) {
    const directoryPath = directoryParts.slice(0, depth).join('/');
    const directoryId = directoryNodeId(directoryPath);
    if (!nodes.has(directoryId)) {
      if (nodes.size >= REPOSITORY_MAP_GRAPH_LIMITS.nodes) return null;
      nodes.set(directoryId, {
        id: directoryId,
        kind: 'directory',
        parentId,
        name: path.posix.basename(directoryPath),
        path: directoryPath,
        modulePath,
      });
      addEdge(edges, 'contains', parentId, directoryId);
    }
    parentId = directoryId;
  }

  return parentId;
}

function parseSourceFile(filePath: string, source: string): ParsedSourceFile {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(filePath),
  );
  const imports: string[] = [];
  const symbols: ExtractedSymbol[] = [];

  for (const statement of sourceFile.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      imports.push(statement.moduleSpecifier.text);
    }

    if (ts.isFunctionDeclaration(statement) && statement.name) {
      symbols.push(
        createSymbol(
          sourceFile,
          statement,
          statement.name.text,
          isComponentName(statement.name.text, filePath) ? 'component' : 'function',
          hasExportModifier(statement),
        ),
      );
      continue;
    }

    if (ts.isClassDeclaration(statement) && statement.name) {
      const exported = hasExportModifier(statement);
      symbols.push(createSymbol(sourceFile, statement, statement.name.text, 'class', exported));
      for (const member of statement.members) {
        if (!ts.isMethodDeclaration(member) || !member.name) continue;
        const memberName = propertyNameText(member.name);
        if (!memberName) continue;
        symbols.push(
          createSymbol(
            sourceFile,
            member,
            `${statement.name.text}.${memberName}`,
            'method',
            exported,
          ),
        );
      }
      continue;
    }

    if (ts.isInterfaceDeclaration(statement)) {
      symbols.push(
        createSymbol(
          sourceFile,
          statement,
          statement.name.text,
          'interface',
          hasExportModifier(statement),
        ),
      );
      continue;
    }

    if (ts.isTypeAliasDeclaration(statement)) {
      symbols.push(
        createSymbol(
          sourceFile,
          statement,
          statement.name.text,
          'type',
          hasExportModifier(statement),
        ),
      );
      continue;
    }

    if (ts.isEnumDeclaration(statement)) {
      symbols.push(
        createSymbol(
          sourceFile,
          statement,
          statement.name.text,
          'enum',
          hasExportModifier(statement),
        ),
      );
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      const exported = hasExportModifier(statement);
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const name = declaration.name.text;
        symbols.push(
          createSymbol(
            sourceFile,
            declaration,
            name,
            isComponentName(name, filePath) ? 'component' : 'variable',
            exported,
          ),
        );
      }
      continue;
    }

    if (ts.isExportAssignment(statement)) {
      symbols.push(
        createSymbol(sourceFile, statement, 'default export', 'export', true),
      );
    }
  }

  return { imports, symbols };
}

function createSymbol(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  name: string,
  kind: RepositoryMapSymbolKind,
  exported: boolean,
): ExtractedSymbol {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    name,
    kind,
    exported,
    range: { startLine: start.line + 1, endLine: end.line + 1 },
  };
}

function hasExportModifier(node: ts.Node): boolean {
  return Boolean(
    ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some(
        (modifier) =>
          modifier.kind === ts.SyntaxKind.ExportKeyword ||
          modifier.kind === ts.SyntaxKind.DefaultKeyword,
      ),
  );
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function scriptKindForPath(filePath: string): ts.ScriptKind {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.tsx') return ts.ScriptKind.TSX;
  if (extension === '.jsx') return ts.ScriptKind.JSX;
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function isComponentName(name: string, filePath: string): boolean {
  return /\.(tsx|jsx)$/.test(filePath) && /^[A-Z]/.test(name);
}

function resolveInternalImport(
  sourcePath: string,
  importPath: string,
  files: Set<string>,
): string | null {
  if (!importPath.startsWith('.')) return null;
  const sourceDirectory = path.posix.dirname(sourcePath);
  const unresolved = normalizePath(path.posix.join(sourceDirectory, importPath));
  const candidates = [
    unresolved,
    ...SOURCE_EXTENSIONS.map((extension) => `${unresolved}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => `${unresolved}/index${extension}`),
  ];
  return candidates.find((candidate) => files.has(candidate)) ?? null;
}

function findModulePath(modules: ModuleSummary[], filePath: string): string {
  const match = modules
    .map((module) => normalizeModulePath(module.path))
    .filter(
      (modulePath) =>
        modulePath !== '.' && (filePath === modulePath || filePath.startsWith(`${modulePath}/`)),
    )
    .toSorted((a, b) => b.length - a.length)[0];
  if (match) return match;
  return modules.some((module) => normalizeModulePath(module.path) === '.') ? '.' : '.';
}

function languageForExtension(extension: string): string | undefined {
  if (extension === '.ts' || extension === '.tsx') return 'TypeScript';
  if (SYMBOL_EXTENSIONS.has(extension)) return 'JavaScript';
  return undefined;
}

function addEdge(
  edges: Map<string, RepositoryMapGraphEdge>,
  kind: RepositoryMapGraphEdge['kind'],
  source: string,
  target: string,
  count?: number,
): void {
  const id = `${kind}:${source}->${target}`;
  if (!edges.has(id) && edges.size >= REPOSITORY_MAP_GRAPH_LIMITS.edges) return;
  edges.set(id, { id, kind, source, target, count });
}

function compareGraphNodes(a: RepositoryMapGraphNode, b: RepositoryMapGraphNode): number {
  const order = { repository: 0, module: 1, directory: 2, file: 3, symbol: 4 };
  return order[a.kind] - order[b.kind] || a.path.localeCompare(b.path) || a.name.localeCompare(b.name);
}

function repositoryNodeId(repoId: string): string {
  return `repository:${repoId}`;
}

function moduleNodeId(modulePath: string): string {
  return `module:${normalizeModulePath(modulePath)}`;
}

function directoryNodeId(directoryPath: string): string {
  return `directory:${normalizePath(directoryPath)}`;
}

function fileNodeId(filePath: string): string {
  return `file:${normalizePath(filePath)}`;
}

function symbolNodeId(filePath: string, symbol: ExtractedSymbol, index: number): string {
  return `symbol:${normalizePath(filePath)}:${symbol.range.startLine}:${symbol.kind}:${symbol.name}:${index}`;
}

function normalizeModulePath(value: string): string {
  const normalized = normalizePath(value);
  return normalized || '.';
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '') || '.';
}

function shortErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 120 ? `${message.slice(0, 117)}...` : message;
}

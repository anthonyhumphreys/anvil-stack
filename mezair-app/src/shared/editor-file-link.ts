export interface EditorFileLocation {
  path: string;
  line?: number;
  column?: number;
  isAbsolute: boolean;
}

interface ParseEditorFileLocationOptions {
  requireFileSignal?: boolean;
}

const FILE_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_ABSOLUTE_PATH_RE = /^[a-z]:[\\/]/i;
const LINE_SUFFIX_RE = /^(.*?)(?::(\d+)(?:-\d+)?)(?::(\d+))?$/;
const HASH_LINE_RE = /^L(\d+)(?:[-:]L?\d+)?$/i;
const SOURCE_EXT_RE = /\.[a-z0-9][a-z0-9_-]*$/i;
const EXTENSIONLESS_FILE_NAMES = new Set([
  'dockerfile',
  'makefile',
  'gemfile',
  'rakefile',
  'procfile',
]);
const DOTFILE_NAMES = new Set([
  '.env',
  '.env.example',
  '.gitignore',
  '.npmrc',
  '.prettierrc',
  '.eslintrc',
]);

export function parseEditorFileLocation(
  rawValue: string | undefined,
  options: ParseEditorFileLocationOptions = {},
): EditorFileLocation | null {
  const requireFileSignal = options.requireFileSignal ?? true;
  const raw = rawValue?.trim();
  if (!raw) return null;

  const localValue = normaliseLocalUri(raw);
  if (!localValue) return null;

  const { pathPart, lineFromQuery, columnFromQuery, hash } = splitFileLocationParts(localValue);
  const {
    path,
    line: lineFromSuffix,
    column: columnFromSuffix,
  } = extractLineSuffix(decodeFilePath(pathPart));
  const lineFromHash = parseHashLine(hash);
  const line = lineFromQuery ?? lineFromHash ?? lineFromSuffix;
  const column = columnFromQuery ?? columnFromSuffix;

  if (!path || (requireFileSignal && !hasFileSignal(path))) {
    return null;
  }

  return {
    path,
    line,
    column,
    isAbsolute: isAbsoluteEditorPath(path),
  };
}

export function isAbsoluteEditorPath(path: string): boolean {
  return path.startsWith('/') || WINDOWS_ABSOLUTE_PATH_RE.test(path);
}

function normaliseLocalUri(raw: string): string | null {
  const value = stripAngleBrackets(raw);

  if (value.startsWith('file://')) {
    try {
      const url = new URL(value);
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return null;
    }
  }

  if (value.startsWith('vscode://file/')) {
    return value.slice('vscode://file'.length);
  }

  if (FILE_SCHEME_RE.test(value) && !WINDOWS_ABSOLUTE_PATH_RE.test(value)) {
    return null;
  }

  return value;
}

function splitFileLocationParts(value: string): {
  pathPart: string;
  lineFromQuery?: number;
  columnFromQuery?: number;
  hash?: string;
} {
  const hashIndex = value.indexOf('#');
  const beforeHash = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const hash = hashIndex >= 0 ? value.slice(hashIndex + 1) : undefined;
  const queryIndex = beforeHash.indexOf('?');
  const pathPart = queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash;
  const query = queryIndex >= 0 ? beforeHash.slice(queryIndex + 1) : '';
  const params = new URLSearchParams(query);

  return {
    pathPart,
    lineFromQuery: parsePositiveInt(params.get('line') ?? params.get('lineNumber')),
    columnFromQuery: parsePositiveInt(params.get('column') ?? params.get('col')),
    hash,
  };
}

function extractLineSuffix(path: string): {
  path: string;
  line?: number;
  column?: number;
} {
  const match = path.match(LINE_SUFFIX_RE);
  if (!match) return { path };

  const candidatePath = match[1];
  if (!hasFileSignal(candidatePath)) return { path };

  return {
    path: candidatePath,
    line: parsePositiveInt(match[2]),
    column: parsePositiveInt(match[3]),
  };
}

function parseHashLine(hash: string | undefined): number | undefined {
  if (!hash) return undefined;

  const githubStyle = hash.match(HASH_LINE_RE);
  if (githubStyle) {
    return parsePositiveInt(githubStyle[1]);
  }

  const lineParam = new URLSearchParams(hash).get('line');
  return parsePositiveInt(lineParam);
}

function hasFileSignal(path: string): boolean {
  const basename = path.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  return (
    SOURCE_EXT_RE.test(basename) ||
    EXTENSIONLESS_FILE_NAMES.has(basename) ||
    DOTFILE_NAMES.has(basename)
  );
}

function parsePositiveInt(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function decodeFilePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function stripAngleBrackets(value: string): string {
  if (value.startsWith('<') && value.endsWith('>')) {
    return value.slice(1, -1);
  }
  return value;
}

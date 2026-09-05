import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import ts from 'typescript';

// Usage: node scripts/measure-footprint.mjs [out-directory] [path/to/Anvil.app]
const output = resolve(process.argv[2] ?? 'out');
const renderer = join(output, 'renderer');
const html = readFileSync(join(renderer, 'index.html'), 'utf8');
const entry = html.match(/<script[^>]+src="([^"]+)"/)?.[1];
if (!entry) throw new Error('Renderer entry script not found');
const initialFiles = new Set();
function visit(file) {
  if (initialFiles.has(file)) return;
  initialFiles.add(file);
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);
  for (const statement of source.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const specifier = statement.moduleSpecifier.text;
      if (specifier.startsWith('.')) visit(resolve(dirname(file), specifier));
    }
  }
}
visit(resolve(renderer, entry));

function directoryBytes(directory) {
  return readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
    const file = join(directory, entry.name);
    return (
      total +
      (entry.isDirectory() ? directoryBytes(file) : entry.isFile() ? statSync(file).size : 0)
    );
  }, 0);
}

const report = {
  capturedAt: new Date().toISOString(),
  output,
  mainEntryBytes: statSync(join(output, 'main/index.js')).size,
  rendererEntryBytes: statSync(resolve(renderer, entry)).size,
  rendererInitialJavaScriptBytes: [...initialFiles].reduce(
    (sum, file) => sum + statSync(file).size,
    0,
  ),
  rendererInitialJavaScriptFiles: initialFiles.size,
  rendererTotalBytes: directoryBytes(renderer),
};

if (process.argv[3]) {
  const bundle = resolve(process.argv[3]);
  const archive = join(bundle, 'Contents/Resources/app.asar');
  const fd = openSync(archive, 'r');
  let tree;
  try {
    const header = Buffer.alloc(16);
    readSync(fd, header, 0, 16, 0);
    const json = Buffer.alloc(header.readUInt32LE(12));
    readSync(fd, json, 0, json.length, 16);
    tree = JSON.parse(json.toString());
  } finally {
    closeSync(fd);
  }
  const packages = new Map();
  function walk(node, path = '') {
    for (const [name, value] of Object.entries(node.files ?? {})) {
      const file = path ? `${path}/${name}` : name;
      if (value.files) walk(value, file);
      else if (file.startsWith('node_modules/')) {
        const parts = file.split('/');
        const key = parts.slice(1, parts[1].startsWith('@') ? 3 : 2).join('/');
        packages.set(key, (packages.get(key) ?? 0) + (value.size ?? 0));
      }
    }
  }
  walk(tree);
  Object.assign(report, {
    bundle,
    bundleLogicalBytes: directoryBytes(bundle),
    archiveBytes: statSync(archive).size,
    largestPackages: [...packages].sort((a, b) => b[1] - a[1]).slice(0, 20),
  });
}
console.log(JSON.stringify(report, null, 2));

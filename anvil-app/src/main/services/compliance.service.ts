import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db/database.js';
import { callLlm } from './llm.service.js';
import { loadPromptTemplate } from '../utils/prompt-templates.js';
import { walkRepo, readFileContent, buildDirectoryTree } from '../utils/file-walker.js';
import type { ComplianceDocType, ComplianceDocument, RepoSummary } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Prompt template mapping
// ---------------------------------------------------------------------------

const TEMPLATE_MAP: Record<ComplianceDocType, string> = {
  dpia: 'compliance-dpia.md',
  'privacy-policy': 'compliance-privacy-policy.md',
  'terms-of-service': 'compliance-tos.md',
};

const DOC_TITLES: Record<ComplianceDocType, string> = {
  dpia: 'Data Protection Impact Assessment',
  'privacy-policy': 'Privacy Policy',
  'terms-of-service': 'Terms of Service',
};

const FILENAME_MAP: Record<ComplianceDocType, string> = {
  dpia: 'DPIA.md',
  'privacy-policy': 'PRIVACY_POLICY.md',
  'terms-of-service': 'TERMS_OF_SERVICE.md',
};

// Files most relevant to data handling / compliance
const COMPLIANCE_RELEVANT_PATTERNS = [
  /auth/i,
  /login/i,
  /session/i,
  /cookie/i,
  /token/i,
  /user/i,
  /account/i,
  /profile/i,
  /register/i,
  /signup/i,
  /password/i,
  /credential/i,
  /secret/i,
  /privacy/i,
  /consent/i,
  /gdpr/i,
  /dpia/i,
  /compliance/i,
  /database/i,
  /schema/i,
  /migration/i,
  /model/i,
  /api/i,
  /route/i,
  /endpoint/i,
  /controller/i,
  /analytics/i,
  /tracking/i,
  /telemetry/i,
  /payment/i,
  /billing/i,
  /stripe/i,
  /checkout/i,
  /email/i,
  /notification/i,
  /sms/i,
  /upload/i,
  /storage/i,
  /s3/i,
  /blob/i,
  /encrypt/i,
  /decrypt/i,
  /hash/i,
  /bcrypt/i,
  /\.env/i,
  /config/i,
  /setting/i,
  /middleware/i,
  /guard/i,
  /policy/i,
];

// ---------------------------------------------------------------------------
// Context gathering — scans the repo for data-handling code
// ---------------------------------------------------------------------------

function isComplianceRelevant(filePath: string): boolean {
  return COMPLIANCE_RELEVANT_PATTERNS.some((p) => p.test(filePath));
}

/** Small config/schema files are included verbatim. */
const VERBATIM_NAMES = new Set([
  'package.json',
  '.env.example',
  '.env.sample',
  'docker-compose.yml',
  'docker-compose.yaml',
  'dockerfile',
  'schema.sql',
]);

function shouldIncludeVerbatim(relativePath: string): boolean {
  const name = path.basename(relativePath).toLowerCase();
  return VERBATIM_NAMES.has(name) || name.endsWith('.prisma') || name.endsWith('.schema');
}

/** Line-level patterns that signal compliance-relevant code. */
const LINE_PATTERNS = [
  /import\b/i,
  /export\b/i,
  /require\s*\(/i,
  /class\s+\w/i,
  /interface\s+\w/i,
  /type\s+\w/i,
  /function\s+\w/i,
  /=>\s*\{/,
  /router\.|app\.(get|post|put|patch|delete|use)\b/i,
  /\.create\b|\.find|\.update|\.delete|\.insert|\.select/i,
  /schema|model\s+\w|@Entity|@Column|@Table/i,
  ...COMPLIANCE_RELEVANT_PATTERNS,
];

/**
 * For large source files, extract only structurally important and
 * compliance-relevant lines with surrounding context.
 */
function extractRelevantExcerpts(content: string, contextLines = 1): string {
  const lines = content.split('\n');
  const keep = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    if (LINE_PATTERNS.some((p) => p.test(lines[i]))) {
      for (
        let j = Math.max(0, i - contextLines);
        j <= Math.min(lines.length - 1, i + contextLines);
        j++
      ) {
        keep.add(j);
      }
    }
  }

  if (keep.size === 0) return '';

  const sorted = [...keep].sort((a, b) => a - b);
  const parts: string[] = [];
  let prev = -2;
  for (const idx of sorted) {
    if (idx > prev + 1) parts.push('  ...');
    parts.push(lines[idx]);
    prev = idx;
  }

  return parts.join('\n');
}

async function gatherSourceContext(repoPath: string, maxChars = 50_000): Promise<string> {
  const files = await walkRepo(repoPath);

  // Prioritise compliance-relevant files
  const relevant = files.filter((f) => isComplianceRelevant(f.relativePath));
  const others = files.filter((f) => !isComplianceRelevant(f.relativePath));

  // Config/schema files first, then compliance-relevant, then a handful of general files
  const configFiles = files.filter((f) => shouldIncludeVerbatim(f.relativePath));

  const prioritised = [...configFiles, ...relevant, ...others.slice(0, 20)];

  // Deduplicate
  const seen = new Set<string>();
  const unique = prioritised.filter((f) => {
    if (seen.has(f.relativePath)) return false;
    seen.add(f.relativePath);
    return true;
  });

  let context = '';
  for (const file of unique) {
    if (context.length >= maxChars) break;

    const raw = readFileContent(repoPath, file.relativePath, 10_000);
    if (!raw.trim()) continue;

    // Small files and config/schema files: include verbatim
    if (raw.length < 2_000 || shouldIncludeVerbatim(file.relativePath)) {
      context += `\n--- ${file.relativePath} ---\n${raw}\n`;
    } else {
      // Larger source files: extract only relevant excerpts
      const excerpts = extractRelevantExcerpts(raw);
      if (excerpts) {
        context += `\n--- ${file.relativePath} (excerpts) ---\n${excerpts}\n`;
      }
    }
  }

  return context;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

function getRepoPath(repoId: string): string {
  const db = getDb();
  const row = db.prepare('SELECT path FROM repos WHERE id = ?').get(repoId) as
    | { path: string }
    | undefined;
  if (!row) throw new Error(`Repo not found: ${repoId}`);
  return row.path;
}

function getRepoSummary(
  repoId: string,
): Pick<
  RepoSummary,
  'overview' | 'frameworks' | 'patterns' | 'entryPoints' | 'configFiles'
> | null {
  const db = getDb();
  const row = db
    .prepare(
      'SELECT overview, frameworks, patterns, entry_points, config_files FROM repo_summaries WHERE repo_id = ?',
    )
    .get(repoId) as
    | {
        overview: string;
        frameworks: string;
        patterns: string;
        entry_points: string;
        config_files: string;
      }
    | undefined;
  if (!row) return null;

  const parseJson = (s: string | null): string[] => {
    if (!s) return [];
    try {
      return JSON.parse(s);
    } catch {
      return [];
    }
  };

  return {
    overview: row.overview ?? '',
    frameworks: parseJson(row.frameworks),
    patterns: parseJson(row.patterns),
    entryPoints: parseJson(row.entry_points),
    configFiles: parseJson(row.config_files),
  };
}

export async function generateComplianceDoc(
  repoId: string,
  docType: ComplianceDocType,
  onProgress?: (message: string, percent: number) => void,
): Promise<ComplianceDocument> {
  const repoPath = getRepoPath(repoId);
  const repoName = path.basename(repoPath);

  onProgress?.('Scanning codebase for data-handling patterns...', 10);

  // Get repo summary if available
  const summary = getRepoSummary(repoId);

  // Gather source context
  onProgress?.('Gathering compliance-relevant source code...', 25);
  const sourceContext = await gatherSourceContext(repoPath);

  // Build file tree
  const files = await walkRepo(repoPath);
  const fileTree = buildDirectoryTree(files);

  onProgress?.(`Generating ${DOC_TITLES[docType]}...`, 40);

  const prompt = loadPromptTemplate(TEMPLATE_MAP[docType], {
    repoName,
    architectureDescription: summary?.overview ?? `A software project located at ${repoPath}`,
    frameworks: summary?.frameworks?.join(', ') ?? 'Not determined — see source context',
    patterns: summary?.patterns?.join(', ') ?? 'Not determined — see source context',
    entryPoints: summary?.entryPoints?.join(', ') ?? 'See source context',
    configFiles: summary?.configFiles?.join(', ') ?? 'See source context',
    fileTree,
    sourceContext,
  });

  onProgress?.('Waiting for LLM response (this may take a minute)...', 50);

  const content = await callLlm(prompt, 8192, 0.3, 3, {
    cwd: repoPath,
    taskClass: 'compliance',
    onProgress: (msg) => onProgress?.(msg, 60),
  });

  onProgress?.('Saving document...', 90);

  // Ensure docs/ directory exists
  const docsDir = path.join(repoPath, 'docs');
  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
  }

  // Clean any markdown code fences the LLM might have wrapped around the output
  let cleaned = content.trim();
  if (cleaned.startsWith('```markdown')) {
    cleaned = cleaned.slice('```markdown'.length);
  } else if (cleaned.startsWith('```md')) {
    cleaned = cleaned.slice('```md'.length);
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.slice(0, -3);
  }
  cleaned = cleaned.trim();

  const filename = FILENAME_MAP[docType];
  const filePath = path.join(docsDir, filename);
  fs.writeFileSync(filePath, cleaned, 'utf-8');

  onProgress?.('Complete', 100);

  return {
    repoId,
    repoName,
    docType,
    filename,
    title: DOC_TITLES[docType],
    content: cleaned,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// List / Read existing compliance docs
// ---------------------------------------------------------------------------

export async function listComplianceDocs(repoId: string): Promise<ComplianceDocument[]> {
  const repoPath = getRepoPath(repoId);
  const repoName = path.basename(repoPath);
  const docsDir = path.join(repoPath, 'docs');

  if (!fs.existsSync(docsDir)) return [];

  const docs: ComplianceDocument[] = [];

  for (const [docType, filename] of Object.entries(FILENAME_MAP)) {
    const filePath = path.join(docsDir, filename);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const stat = fs.statSync(filePath);
      docs.push({
        repoId,
        repoName,
        docType: docType as ComplianceDocType,
        filename,
        title: DOC_TITLES[docType as ComplianceDocType],
        content,
        generatedAt: stat.mtime.toISOString(),
      });
    }
  }

  return docs;
}

export async function readComplianceDoc(
  repoId: string,
  docType: ComplianceDocType,
): Promise<ComplianceDocument | null> {
  const repoPath = getRepoPath(repoId);
  const repoName = path.basename(repoPath);
  const filename = FILENAME_MAP[docType];
  const filePath = path.join(repoPath, 'docs', filename);

  if (!fs.existsSync(filePath)) return null;

  const content = fs.readFileSync(filePath, 'utf-8');
  const stat = fs.statSync(filePath);

  return {
    repoId,
    repoName,
    docType,
    filename,
    title: DOC_TITLES[docType],
    content,
    generatedAt: stat.mtime.toISOString(),
  };
}

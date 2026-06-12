import { loadPromptTemplate } from '../utils/prompt-templates.js';
import { callLlm } from './llm.service.js';
import { createAudit, createFinding, updateAuditStatus } from './security-persistence.service.js';
import { getSettings } from './settings.service.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import type { RepoSummary } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Scope detection based on frameworks and languages
// ---------------------------------------------------------------------------

export function detectAuditScope(
  summary: RepoSummary,
  languages: Array<{ language: string; percentage: number }>,
): string[] {
  const scope: string[] = ['OWASP Top 10 2021'];

  const frameworksLower = summary.frameworks.map((f) => f.toLowerCase());
  const languageLower = languages.map((l) => l.language.toLowerCase());

  // API detection
  const isApi =
    frameworksLower.some((f) =>
      [
        'express',
        'fastify',
        'koa',
        'nestjs',
        'flask',
        'django',
        'fastapi',
        'spring',
        'asp.net',
        'gin',
        'fiber',
      ].includes(f),
    ) ||
    summary.patterns.some(
      (p) => p.toLowerCase().includes('api') || p.toLowerCase().includes('rest'),
    );
  if (isApi) scope.push('OWASP API Security Top 10 2023');

  // Mobile detection
  const isMobile =
    frameworksLower.some((f) =>
      ['react native', 'flutter', 'swift', 'kotlin', 'xamarin', 'expo'].includes(f),
    ) || languageLower.some((l) => ['swift', 'kotlin', 'dart'].includes(l));
  if (isMobile) scope.push('OWASP Mobile Top 10 2024');

  // Web app gets ASVS
  const isWebApp = frameworksLower.some((f) =>
    ['react', 'angular', 'vue', 'next.js', 'nuxt', 'svelte', 'blazor'].includes(f),
  );
  if (isWebApp) scope.push('OWASP ASVS 4.0');

  return scope;
}

// ---------------------------------------------------------------------------
// Finding parsing
// ---------------------------------------------------------------------------

interface AuditFinding {
  severity: string;
  category: string;
  owaspRef?: string;
  cweRef?: string;
  affectedFiles: string[];
  description: string;
  remediation?: string;
}

/**
 * Parse findings from LLM JSON response.
 */
function parseFindingsResponse(text: string): AuditFinding[] {
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);

  // Try multiple extraction strategies for robustness
  const candidates: string[] = [];
  if (fenceMatch) candidates.push(fenceMatch[1]);

  // Try to find a JSON array or object anywhere in the text
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) candidates.push(arrayMatch[0]);

  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch) candidates.push(objectMatch[0]);

  // Fallback to full text
  candidates.push(text);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      const findings = Array.isArray(parsed) ? parsed : (parsed.findings ?? []);
      return findings.map((f: Record<string, unknown>) => ({
        severity: String(f.severity ?? 'info').toLowerCase(),
        category: String(f.category ?? 'Unknown'),
        owaspRef: f.owaspRef ? String(f.owaspRef) : undefined,
        cweRef: f.cweRef ? String(f.cweRef) : undefined,
        affectedFiles: Array.isArray(f.affectedFiles) ? f.affectedFiles.map(String) : [],
        description: String(f.description ?? ''),
        remediation: f.remediation ? String(f.remediation) : undefined,
      }));
    } catch {
      // Try next candidate
    }
  }

  console.warn('[Security] Failed to parse findings JSON from LLM response');
  return [];
}

// ---------------------------------------------------------------------------
// Main audit function
// ---------------------------------------------------------------------------

export async function runSecurityAudit(
  auditId: string,
  repoId: string,
  summary: RepoSummary,
  languages: Array<{ language: string; percentage: number }>,
  sendProgress: (message: string, percent: number) => void,
): Promise<string> {
  const scope = detectAuditScope(summary, languages);
  const llmConcurrency = getSettings().llmProvider === 'codex' ? 1 : 3;

  try {
    sendProgress('Detecting audit scope...', 5);

    const allFindings: AuditFinding[] = [];
    const modules = summary.modules;
    const totalModules = modules.length;
    let completedModules = 0;
    const progressPercent = () =>
      totalModules === 0 ? 90 : Math.round(10 + (80 * completedModules) / totalModules);

    const moduleFindings = await mapWithConcurrency(modules, llmConcurrency, async (mod) => {
      const baseMessage = `Analyzing module: ${mod.path}...`;
      sendProgress(baseMessage, progressPercent());

      try {
        const prompt = loadPromptTemplate('security-audit.md', {
          repoName: summary.overview.split('.')[0] || 'Repository',
          modulePath: mod.path,
          modulePurpose: mod.purpose,
          keyFiles: mod.keyFiles.join(', '),
          dependencies: mod.dependencies.join(', '),
          frameworks: summary.frameworks.join(', '),
          patterns: summary.patterns.join(', '),
          scope: scope.join(', '),
          architectureDescription: summary.overview,
        });

        const response = await callLlm(prompt, 4096, 0.2, 2, {
          taskClass: 'security',
          onProgress: (detail) => sendProgress(`${baseMessage} ${detail}`, progressPercent()),
        });
        return parseFindingsResponse(response);
      } catch (err) {
        console.error(`[Security] Error analyzing module ${mod.path}:`, err);
        return [];
      } finally {
        completedModules += 1;
        sendProgress(
          `Analyzed ${completedModules} of ${totalModules} module${totalModules === 1 ? '' : 's'}...`,
          progressPercent(),
        );
      }
    });
    allFindings.push(...moduleFindings.flat());

    // Deduplication and aggregation
    sendProgress('Aggregating and deduplicating findings...', 90);

    // Simple dedup by description similarity
    const seen = new Set<string>();
    const deduped = allFindings.filter((f) => {
      const key = `${f.category}:${f.description.substring(0, 100)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Persist findings
    for (const finding of deduped) {
      createFinding({
        auditId,
        severity: finding.severity as 'critical' | 'high' | 'medium' | 'low' | 'info',
        category: finding.category,
        owaspRef: finding.owaspRef,
        cweRef: finding.cweRef,
        affectedFiles: finding.affectedFiles,
        description: finding.description,
        remediation: finding.remediation,
      });
    }

    // Generate executive summary
    sendProgress('Generating executive summary...', 95);

    const severityCounts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const f of deduped) {
      const sev = f.severity as keyof typeof severityCounts;
      if (sev in severityCounts) severityCounts[sev]++;
    }

    const summaryText =
      `Security audit completed. Scope: ${scope.join(', ')}. ` +
      `Found ${deduped.length} findings: ` +
      `${severityCounts.critical} critical, ${severityCounts.high} high, ` +
      `${severityCounts.medium} medium, ${severityCounts.low} low, ${severityCounts.info} informational.`;

    updateAuditStatus(auditId, 'completed', summaryText);
    sendProgress('Audit complete', 100);

    return auditId;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    updateAuditStatus(auditId, 'failed', `Audit failed: ${errorMsg}`);
    sendProgress('Audit failed', 0);
    throw err;
  }
}

export function createPendingSecurityAudit(
  repoId: string,
  summary: RepoSummary,
  languages: Array<{ language: string; percentage: number }>,
): string {
  return createAudit({
    repoId,
    scope: detectAuditScope(summary, languages),
  });
}

// ---------------------------------------------------------------------------
// Markdown report generation
// ---------------------------------------------------------------------------

export function generateMarkdownReport(
  audit: {
    id: string;
    repoId: string;
    scope: string[];
    summary?: string;
    startedAt: string;
    completedAt?: string;
  },
  findings: Array<{
    severity: string;
    category: string;
    owaspRef?: string;
    cweRef?: string;
    affectedFiles: string[];
    description: string;
    remediation?: string;
    dismissed: boolean;
  }>,
  repoName: string,
): string {
  const lines: string[] = [
    `# Security Audit Report — ${repoName}`,
    '',
    `**Audit ID:** ${audit.id}`,
    `**Date:** ${audit.completedAt || audit.startedAt}`,
    `**Scope:** ${audit.scope.join(', ')}`,
    '',
    '## Executive Summary',
    '',
    audit.summary || 'No summary available.',
    '',
    '## Findings',
    '',
  ];

  const activeFindings = findings.filter((f) => !f.dismissed);
  const severityOrder = ['critical', 'high', 'medium', 'low', 'info'];
  const grouped = new Map<string, typeof activeFindings>();

  for (const f of activeFindings) {
    const cat = f.category;
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(f);
  }

  // Sort categories by highest severity finding
  const sortedCategories = [...grouped.entries()].sort((a, b) => {
    const aMax = Math.min(...a[1].map((f) => severityOrder.indexOf(f.severity)));
    const bMax = Math.min(...b[1].map((f) => severityOrder.indexOf(f.severity)));
    return aMax - bMax;
  });

  for (const [category, catFindings] of sortedCategories) {
    lines.push(`### ${category}`, '');

    for (const f of catFindings) {
      const sevBadge = f.severity.toUpperCase();
      lines.push(`#### [${sevBadge}] ${f.description.split('\n')[0]}`);
      if (f.owaspRef) lines.push(`- **OWASP:** ${f.owaspRef}`);
      if (f.cweRef) lines.push(`- **CWE:** ${f.cweRef}`);
      if (f.affectedFiles.length > 0) {
        lines.push(
          `- **Affected files:** ${f.affectedFiles.map((af) => '`' + af + '`').join(', ')}`,
        );
      }
      lines.push('', f.description, '');
      if (f.remediation) {
        lines.push('**Remediation:**', '', f.remediation, '');
      }
    }
  }

  if (activeFindings.length === 0) {
    lines.push('No active findings.', '');
  }

  lines.push('---', `*Generated by Anvil Security Audit*`);

  return lines.join('\n');
}

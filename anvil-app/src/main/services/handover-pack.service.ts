import { randomUUID } from 'node:crypto';
import { mkdirSync, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow, dialog } from 'electron';
import archiver from 'archiver';
import { getDb } from '../db/database.js';
import { getItem, getGateTemplates, listGateDecisions } from './lifecycle.service.js';
import { listAnalyses } from './impact-analysis.service.js';
import { getGateFallbackLabel } from '../../shared/lifecycle-types.js';
import type {
  GateId,
  HandoverPack,
  HandoverSection,
  HandoverProgress,
} from '../../shared/lifecycle-types.js';
import { getLegacyHiddenDirPath, getPrimaryHiddenDirPath } from '../utils/app-paths.js';

// ---------------------------------------------------------------------------
// Internal row type
// ---------------------------------------------------------------------------

interface HandoverPackRow {
  id: string;
  lifecycle_item_id: string;
  generated_at: string;
  output_path: string;
  sections: string;
}

function mapPack(row: HandoverPackRow): HandoverPack {
  return {
    id: row.id,
    lifecycleItemId: row.lifecycle_item_id,
    generatedAt: row.generated_at,
    outputPath: row.output_path,
    sections: JSON.parse(row.sections) as HandoverSection[],
  };
}

// ---------------------------------------------------------------------------
// Progress helper
// ---------------------------------------------------------------------------

function emitProgress(data: HandoverProgress): void {
  const win = BrowserWindow.getAllWindows()[0];
  win?.webContents.send('lifecycle:handover-progress', data);
}

// ---------------------------------------------------------------------------
// Section generators
// ---------------------------------------------------------------------------

function generateArchitectureOverview(repoIds: string[]): { content: string; available: boolean } {
  const db = getDb();
  const parts: string[] = ['# Architecture Overview\n'];
  let available = false;

  for (const repoId of repoIds) {
    const summary = db
      .prepare(
        'SELECT overview, architecture_description, mermaid_diagram FROM repo_summaries WHERE repo_id = ?',
      )
      .get(repoId) as
      | {
          overview: string | null;
          architecture_description: string | null;
          mermaid_diagram: string | null;
        }
      | undefined;
    const repo = db.prepare('SELECT name FROM repos WHERE id = ?').get(repoId) as
      | { name: string }
      | undefined;

    if (summary && repo) {
      available = true;
      parts.push(`## ${repo.name}\n`);
      if (summary.overview) parts.push(`### Overview\n${summary.overview}\n`);
      if (summary.architecture_description)
        parts.push(`### Architecture\n${summary.architecture_description}\n`);
      if (summary.mermaid_diagram)
        parts.push(`### Diagram\n\`\`\`mermaid\n${summary.mermaid_diagram}\n\`\`\`\n`);
    }
  }

  if (!available) parts.push('*Not yet generated — run repo indexing to produce this artefact.*\n');
  return { content: parts.join('\n'), available };
}

function generateModuleInventory(repoIds: string[]): { content: string; available: boolean } {
  const db = getDb();
  const parts: string[] = ['# Module Inventory\n'];
  let available = false;

  for (const repoId of repoIds) {
    const repo = db.prepare('SELECT name FROM repos WHERE id = ?').get(repoId) as
      | { name: string }
      | undefined;
    const modules = db
      .prepare(
        'SELECT path, purpose, file_count, key_files, dependencies FROM module_summaries WHERE repo_id = ? ORDER BY path',
      )
      .all(repoId) as Array<{
      path: string;
      purpose: string | null;
      file_count: number | null;
      key_files: string | null;
      dependencies: string | null;
    }>;

    if (modules.length > 0 && repo) {
      available = true;
      parts.push(`## ${repo.name}\n`);
      for (const m of modules) {
        parts.push(`### ${m.path}\n`);
        if (m.purpose) parts.push(`${m.purpose}\n`);
        if (m.file_count) parts.push(`- **Files:** ${m.file_count}\n`);
        if (m.key_files) {
          const kf = JSON.parse(m.key_files) as string[];
          parts.push(`- **Key files:** ${kf.join(', ')}\n`);
        }
        if (m.dependencies) {
          const deps = JSON.parse(m.dependencies) as string[];
          parts.push(`- **Dependencies:** ${deps.join(', ')}\n`);
        }
        parts.push('');
      }
    }
  }

  if (!available) parts.push('*Not yet generated — run repo indexing to produce this artefact.*\n');
  return { content: parts.join('\n'), available };
}

function generateSecurityAuditReport(repoIds: string[]): { content: string; available: boolean } {
  const db = getDb();
  const parts: string[] = ['# Security Audit Report\n'];
  let available = false;

  for (const repoId of repoIds) {
    const audit = db
      .prepare(
        "SELECT id, summary, started_at, completed_at FROM security_audits WHERE repo_id = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 1",
      )
      .get(repoId) as
      | { id: string; summary: string | null; started_at: string; completed_at: string }
      | undefined;

    if (audit) {
      available = true;
      const repo = db.prepare('SELECT name FROM repos WHERE id = ?').get(repoId) as {
        name: string;
      };
      parts.push(`## ${repo.name}\n`);
      parts.push(`**Audit date:** ${audit.completed_at}\n`);
      if (audit.summary) parts.push(`${audit.summary}\n`);

      const findings = db
        .prepare(
          "SELECT severity, category, owasp_ref, cwe_ref, affected_files, description, remediation FROM security_findings WHERE audit_id = ? AND dismissed = 0 ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END",
        )
        .all(audit.id) as Array<{
        severity: string;
        category: string;
        owasp_ref: string | null;
        cwe_ref: string | null;
        affected_files: string | null;
        description: string;
        remediation: string | null;
      }>;

      for (const f of findings) {
        parts.push(`### [${f.severity.toUpperCase()}] ${f.category}\n`);
        if (f.owasp_ref) parts.push(`- **OWASP:** ${f.owasp_ref}\n`);
        if (f.cwe_ref) parts.push(`- **CWE:** ${f.cwe_ref}\n`);
        if (f.affected_files) {
          const files = JSON.parse(f.affected_files) as string[];
          parts.push(`- **Affected files:** ${files.join(', ')}\n`);
        }
        parts.push(`\n${f.description}\n`);
        if (f.remediation) parts.push(`\n**Remediation:** ${f.remediation}\n`);
        parts.push('');
      }
    }
  }

  if (!available)
    parts.push('*Not yet generated — run a security audit to produce this artefact.*\n');
  return { content: parts.join('\n'), available };
}

function generateCodeReviewSummary(repoIds: string[]): { content: string; available: boolean } {
  const db = getDb();
  const parts: string[] = ['# Code Review Summary\n'];
  let available = false;

  for (const repoId of repoIds) {
    const review = db
      .prepare(
        "SELECT id, mode, scope_type, summary, completed_at FROM code_reviews WHERE repo_id = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 1",
      )
      .get(repoId) as
      | {
          id: string;
          mode: string;
          scope_type: string;
          summary: string | null;
          completed_at: string;
        }
      | undefined;

    if (review) {
      available = true;
      const repo = db.prepare('SELECT name FROM repos WHERE id = ?').get(repoId) as {
        name: string;
      };
      parts.push(`## ${repo.name}\n`);
      parts.push(
        `**Mode:** ${review.mode} | **Scope:** ${review.scope_type} | **Date:** ${review.completed_at}\n`,
      );
      if (review.summary) parts.push(`${review.summary}\n`);

      const findings = db
        .prepare(
          "SELECT severity, category, file_path, description, suggestion FROM code_review_findings WHERE review_id = ? AND dismissed = 0 ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'major' THEN 2 WHEN 'minor' THEN 3 ELSE 4 END",
        )
        .all(review.id) as Array<{
        severity: string;
        category: string;
        file_path: string | null;
        description: string;
        suggestion: string | null;
      }>;

      for (const f of findings) {
        parts.push(`### [${f.severity.toUpperCase()}] ${f.category}\n`);
        if (f.file_path) parts.push(`**File:** \`${f.file_path}\`\n`);
        parts.push(`${f.description}\n`);
        if (f.suggestion) parts.push(`**Suggestion:** ${f.suggestion}\n`);
        parts.push('');
      }
    }
  }

  if (!available) parts.push('*Not yet generated — run a code review to produce this artefact.*\n');
  return { content: parts.join('\n'), available };
}

function generateGateDecisionsDoc(lifecycleItemId: string): {
  content: string;
  available: boolean;
} {
  const decisions = listGateDecisions(lifecycleItemId);
  const parts: string[] = ['# Gate Decisions\n'];

  if (decisions.length === 0) {
    parts.push('*No gate decisions recorded yet.*\n');
    return { content: parts.join('\n'), available: false };
  }

  const item = getItem(lifecycleItemId);
  const templates = getGateTemplates(item.workspaceId);
  const gateLabels = new Map(
    templates.map((template) => [
      template.gate,
      template.label.trim() || getGateFallbackLabel(template.gate),
    ]),
  );

  for (const d of decisions) {
    parts.push(`## ${gateLabels.get(d.gate as GateId) ?? d.gate}\n`);
    parts.push(`- **Decision:** ${d.decision.replace(/_/g, ' ')}\n`);
    parts.push(`- **Decided by:** ${d.decidedBy}\n`);
    parts.push(`- **Date:** ${d.decidedAt}\n`);
    if (d.conditions) parts.push(`- **Conditions:** ${d.conditions}\n`);
    if (d.rationale) parts.push(`- **Rationale:** ${d.rationale}\n`);
    parts.push('');
  }

  return { content: parts.join('\n'), available: true };
}

function generateImpactAnalysisDoc(lifecycleItemId: string): {
  content: string;
  available: boolean;
} {
  const analyses = listAnalyses(lifecycleItemId);
  const latest = analyses.find((a) => a.status === 'completed');

  if (!latest) {
    return {
      content:
        '# Impact Analysis\n\n*Not yet generated — run an impact analysis to produce this artefact.*\n',
      available: false,
    };
  }

  const parts: string[] = ['# Impact Analysis\n'];
  parts.push(`**Date:** ${latest.completedAt}\n`);
  parts.push(`**Risk Rating:** ${latest.riskRating?.toUpperCase()}\n`);
  parts.push(`**Scope:** ${latest.scopeType.replace('_', ' ')}\n\n`);

  parts.push(`## Executive Summary\n${latest.executiveSummary}\n\n`);

  if (latest.affectedModules.length > 0) {
    parts.push('## Affected Modules\n');
    for (const m of latest.affectedModules) {
      parts.push(`### ${m.modulePath} — ${m.impactLevel.toUpperCase()}\n`);
      parts.push(`${m.impactDescription}\n`);
      if (m.affectedFiles.length > 0)
        parts.push(`- **Affected files:** ${m.affectedFiles.join(', ')}\n`);
      if (m.downstreamDependents.length > 0)
        parts.push(`- **Downstream dependents:** ${m.downstreamDependents.join(', ')}\n`);
      parts.push('');
    }
  }

  if (latest.technologyChanges.length > 0) {
    parts.push('## Technology Changes\n');
    for (const t of latest.technologyChanges) parts.push(`- ${t}\n`);
    parts.push('');
  }

  if (latest.crossCuttingConcerns.length > 0) {
    parts.push('## Cross-Cutting Concerns\n');
    for (const c of latest.crossCuttingConcerns) parts.push(`- ${c}\n`);
    parts.push('');
  }

  if (latest.technicalAppendix) {
    parts.push(`## Technical Appendix\n${latest.technicalAppendix}\n`);
  }

  return { content: parts.join('\n'), available: true };
}

function generateComplianceDocs(repoIds: string[]): { content: string; available: boolean } {
  const db = getDb();
  const parts: string[] = ['# Compliance Documents\n'];
  let available = false;

  for (const repoId of repoIds) {
    const repo = db.prepare('SELECT name, path FROM repos WHERE id = ?').get(repoId) as
      | { name: string; path: string }
      | undefined;
    if (!repo) continue;

    const docsDir = join(repo.path, 'docs');

    const complianceFiles = ['DPIA.md', 'privacy-policy.md', 'terms-of-service.md'];
    for (const file of complianceFiles) {
      const filePath = join(docsDir, file);
      if (existsSync(filePath)) {
        available = true;
        const content = readFileSync(filePath, 'utf-8');
        parts.push(`## ${repo.name} — ${file}\n\n${content}\n\n---\n`);
      }
    }
  }

  if (!available)
    parts.push(
      '*Not yet generated — run compliance document generation to produce this artefact.*\n',
    );
  return { content: parts.join('\n'), available };
}

function generateConfigInventory(repoIds: string[]): { content: string; available: boolean } {
  const db = getDb();
  const parts: string[] = ['# Configuration Inventory\n'];
  let available = false;

  for (const repoId of repoIds) {
    const summary = db
      .prepare('SELECT config_files FROM repo_summaries WHERE repo_id = ?')
      .get(repoId) as { config_files: string | null } | undefined;
    const repo = db.prepare('SELECT name FROM repos WHERE id = ?').get(repoId) as
      | { name: string }
      | undefined;

    if (summary?.config_files && repo) {
      available = true;
      const configs = JSON.parse(summary.config_files) as string[];
      parts.push(`## ${repo.name}\n`);
      for (const c of configs) parts.push(`- \`${c}\`\n`);
      parts.push('');
    }
  }

  if (!available) parts.push('*Not yet generated — run repo indexing to produce this artefact.*\n');
  return { content: parts.join('\n'), available };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function generatePack(lifecycleItemId: string): Promise<HandoverPack> {
  const db = getDb();
  const item = getItem(lifecycleItemId);
  const id = randomUUID();

  const hiddenBaseDir = existsSync(getPrimaryHiddenDirPath())
    ? getPrimaryHiddenDirPath()
    : existsSync(getLegacyHiddenDirPath())
      ? getLegacyHiddenDirPath()
      : getPrimaryHiddenDirPath();
  const outputDir = join(hiddenBaseDir, 'handover-packs', lifecycleItemId);
  mkdirSync(outputDir, { recursive: true });
  const zipPath = join(outputDir, `handover-pack-${new Date().toISOString().slice(0, 10)}.zip`);

  const sectionGenerators: Array<{
    name: string;
    sourceType: string;
    fileName: string;
    generate: () => { content: string; available: boolean };
  }> = [
    {
      name: 'Architecture Overview',
      sourceType: 'repo_summary',
      fileName: '01-architecture-overview.md',
      generate: () => generateArchitectureOverview(item.linkedRepoIds),
    },
    {
      name: 'Module Inventory',
      sourceType: 'module_summary',
      fileName: '02-module-inventory.md',
      generate: () => generateModuleInventory(item.linkedRepoIds),
    },
    {
      name: 'Architecture Decisions',
      sourceType: 'adr',
      fileName: '03-architecture-decisions.md',
      generate: () => ({
        content:
          '# Architecture Decisions\n\n*ADRs are stored in repository filesystem — see linked repos for full ADR content.*\n',
        available: true,
      }),
    },
    {
      name: 'Impact Analysis',
      sourceType: 'impact_analysis',
      fileName: '04-impact-analysis.md',
      generate: () => generateImpactAnalysisDoc(lifecycleItemId),
    },
    {
      name: 'Security Audit Report',
      sourceType: 'security_audit',
      fileName: '05-security-audit-report.md',
      generate: () => generateSecurityAuditReport(item.linkedRepoIds),
    },
    {
      name: 'Code Review Summary',
      sourceType: 'code_review',
      fileName: '06-code-review-summary.md',
      generate: () => generateCodeReviewSummary(item.linkedRepoIds),
    },
    {
      name: 'Compliance Documents',
      sourceType: 'compliance',
      fileName: '07-compliance.md',
      generate: () => generateComplianceDocs(item.linkedRepoIds),
    },
    {
      name: 'Gate Decisions',
      sourceType: 'gate_decisions',
      fileName: '08-gate-decisions.md',
      generate: () => generateGateDecisionsDoc(lifecycleItemId),
    },
    {
      name: 'Configuration Inventory',
      sourceType: 'config',
      fileName: '09-configuration-inventory.md',
      generate: () => generateConfigInventory(item.linkedRepoIds),
    },
  ];

  const sections: HandoverSection[] = [];

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', reject);
    output.on('close', resolve);
    archive.pipe(output);

    for (let i = 0; i < sectionGenerators.length; i++) {
      const gen = sectionGenerators[i];
      emitProgress({
        lifecycleItemId,
        section: gen.name,
        message: `Assembling ${gen.name}...`,
        percent: Math.round(((i + 1) / sectionGenerators.length) * 100),
      });

      const { content, available } = gen.generate();
      archive.append(content, { name: gen.fileName });
      sections.push({
        name: gen.name,
        sourceType: gen.sourceType,
        included: available,
        fileName: gen.fileName,
      });
    }

    archive.finalize();
  });

  db.prepare(
    `INSERT INTO handover_packs (id, lifecycle_item_id, generated_at, output_path, sections)
     VALUES (?, ?, datetime('now'), ?, ?)`,
  ).run(id, lifecycleItemId, zipPath, JSON.stringify(sections));

  const row = db.prepare('SELECT * FROM handover_packs WHERE id = ?').get(id) as HandoverPackRow;
  return mapPack(row);
}

export function listPacks(lifecycleItemId: string): HandoverPack[] {
  const rows = getDb()
    .prepare('SELECT * FROM handover_packs WHERE lifecycle_item_id = ? ORDER BY generated_at DESC')
    .all(lifecycleItemId) as HandoverPackRow[];
  return rows.map(mapPack);
}

export async function exportPack(packId: string): Promise<string | null> {
  const row = getDb().prepare('SELECT * FROM handover_packs WHERE id = ?').get(packId) as
    | HandoverPackRow
    | undefined;
  if (!row) throw new Error(`Handover pack not found: ${packId}`);

  const win = BrowserWindow.getAllWindows()[0];
  const { canceled, filePath } = await dialog.showSaveDialog(win!, {
    title: 'Export Handover Pack',
    defaultPath: `handover-pack-${new Date().toISOString().slice(0, 10)}.zip`,
    filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
  });

  if (canceled || !filePath) return null;

  const { copyFileSync } = await import('node:fs');
  copyFileSync(row.output_path, filePath);
  return filePath;
}

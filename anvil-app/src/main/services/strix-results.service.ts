// src/main/services/strix-results.service.ts

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createFinding, type CreateFindingInput } from './pentest-persistence.service.js';
import type { PentestScan, PentestFinding } from '../../shared/pentest-types.js';

// ---------------------------------------------------------------------------
// Parse Strix output directory into findings
// ---------------------------------------------------------------------------

export async function parseStrixResults(scanId: string, outputDir: string): Promise<void> {
  try {
    const entries = await readdir(outputDir, { withFileTypes: true });

    // Look for JSON result files in the output directory
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        try {
          const content = await readFile(path.join(outputDir, entry.name), 'utf-8');
          const data = JSON.parse(content);

          // Handle array of findings, object with `findings` key, or single finding object
          const rawFindings: unknown[] = Array.isArray(data)
            ? data
            : data.findings
              ? data.findings
              : [data];

          for (const raw of rawFindings) {
            if (!raw || typeof raw !== 'object') continue;
            const f = raw as Record<string, unknown>;

            const input: CreateFindingInput = {
              scanId,
              severity: normalizeSeverity(f.severity),
              category: String(f.category || f.type || 'Unknown'),
              owaspRef: f.owasp_ref
                ? String(f.owasp_ref)
                : f.owaspRef
                  ? String(f.owaspRef)
                  : undefined,
              cweRef: f.cwe_ref ? String(f.cwe_ref) : f.cweRef ? String(f.cweRef) : undefined,
              affectedEndpoints: normalizeStringArray(
                f.affected_endpoints || f.affectedEndpoints || f.endpoints || [],
              ),
              description: String(f.description || f.summary || ''),
              pocPayload: f.poc_payload
                ? String(f.poc_payload)
                : f.pocPayload
                  ? String(f.pocPayload)
                  : f.poc
                    ? String(f.poc)
                    : undefined,
              pocResponse: f.poc_response
                ? String(f.poc_response)
                : f.pocResponse
                  ? String(f.pocResponse)
                  : undefined,
              reproductionSteps: f.reproduction_steps
                ? String(f.reproduction_steps)
                : f.reproductionSteps
                  ? String(f.reproductionSteps)
                  : f.steps
                    ? String(f.steps)
                    : undefined,
              remediation: f.remediation
                ? String(f.remediation)
                : f.fix
                  ? String(f.fix)
                  : undefined,
              agentTrace: f.agent_trace
                ? String(f.agent_trace)
                : f.agent
                  ? String(f.agent)
                  : undefined,
            };

            if (input.description) {
              createFinding(input);
            }
          }
        } catch {
          console.warn(`[Strix] Failed to parse result file: ${entry.name}`);
        }
      }

      // Recurse into subdirectories (strix_runs may have nested structure)
      if (entry.isDirectory()) {
        await parseStrixResults(scanId, path.join(outputDir, entry.name));
      }
    }
  } catch {
    // Output directory may not exist if scan failed early
    console.warn(`[Strix] Could not read output directory: ${outputDir}`);
  }
}

function normalizeSeverity(val: unknown): PentestFinding['severity'] {
  const s = String(val || 'info').toLowerCase();
  if (['critical', 'high', 'medium', 'low', 'info'].includes(s)) {
    return s as PentestFinding['severity'];
  }
  return 'info';
}

function normalizeStringArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === 'string') return [val];
  return [];
}

// ---------------------------------------------------------------------------
// Markdown report generation
// ---------------------------------------------------------------------------

export function generatePentestMarkdownReport(
  scan: PentestScan,
  findings: PentestFinding[],
  repoName: string,
): string {
  const lines: string[] = [
    `# Penetration Test Report — ${repoName}`,
    '',
    `**Scan ID:** ${scan.id}`,
    `**Date:** ${scan.completedAt || scan.startedAt}`,
    `**Target:** ${scan.targetType === 'url' ? scan.targetValue : 'Local repository'}`,
    `**Categories:** ${scan.categories.join(', ')}`,
    '',
    '## Executive Summary',
    '',
    scan.summary || 'No summary available.',
    '',
    '## Findings',
    '',
  ];

  const activeFindings = findings.filter((f) => !f.dismissed);
  const severityOrder = ['critical', 'high', 'medium', 'low', 'info'];
  const grouped = new Map<string, PentestFinding[]>();

  for (const f of activeFindings) {
    if (!grouped.has(f.category)) grouped.set(f.category, []);
    grouped.get(f.category)!.push(f);
  }

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
      if (f.affectedEndpoints.length > 0) {
        lines.push(
          `- **Affected endpoints:** ${f.affectedEndpoints.map((e) => '`' + e + '`').join(', ')}`,
        );
      }
      lines.push('', f.description, '');

      if (f.pocPayload) {
        lines.push('**Proof of Concept:**', '', '```', f.pocPayload, '```', '');
      }
      if (f.pocResponse) {
        lines.push('**Server Response:**', '', '```', f.pocResponse, '```', '');
      }
      if (f.reproductionSteps) {
        lines.push('**Reproduction Steps:**', '', f.reproductionSteps, '');
      }
      if (f.remediation) {
        lines.push('**Remediation:**', '', f.remediation, '');
      }
    }
  }

  if (activeFindings.length === 0) {
    lines.push('No active findings.', '');
  }

  lines.push('---', '*Generated by Anvil Penetration Testing (powered by Strix)*');
  return lines.join('\n');
}

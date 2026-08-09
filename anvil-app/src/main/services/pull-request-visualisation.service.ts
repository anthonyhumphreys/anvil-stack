import type {
  CodeReviewFinding,
  CodeReviewPullRequest,
  PullRequestDiff,
  PullRequestVisualisation,
  PullRequestVisualisationChangeState,
  PullRequestVisualisationNodeKind,
  PullRequestVisualisationTone,
} from '../../shared/types.js';
import { loadPromptTemplate } from '../utils/prompt-templates.js';
import { summarizeDiffFiles, type GitDiffFile } from './code-review-git.service.js';
import { getFindings } from './code-review-persistence.service.js';
import { resolvePullRequestForReview } from './code-review-pr.service.js';
import { callLlm } from './llm.service.js';
import {
  beginPullRequestVisualisation,
  completePullRequestVisualisation,
  failPullRequestVisualisation,
  getLatestPullRequestVisualisation,
} from './pull-request-visualisation-persistence.service.js';

const MAX_VISUALISATION_DIFF_CHARS = 180_000;
const TONES = new Set<PullRequestVisualisationTone>([
  'neutral',
  'action',
  'data',
  'verified',
  'risk',
  'logic',
  'uncertainty',
]);
const NODE_KINDS = new Set<PullRequestVisualisationNodeKind>([
  'entry',
  'service',
  'data',
  'file',
  'test',
  'external',
  'risk',
]);
const CHANGE_STATES = new Set<PullRequestVisualisationChangeState>(['before', 'after', 'both']);

type VisualisationOutput = Pick<
  PullRequestVisualisation,
  'summary' | 'intent' | 'chapters' | 'nodes' | 'edges' | 'risks' | 'evidence'
>;

export interface GeneratePullRequestVisualisationOptions {
  repoId: string;
  repoPath: string;
  remoteUrl?: string | null;
  pullRequestId: string;
  repoContext: string;
  reviewId?: string;
  force?: boolean;
  onProgress?: (message: string) => void;
}

export async function getPullRequestDiff(input: {
  repoPath: string;
  remoteUrl?: string | null;
  pullRequestId: string;
}): Promise<PullRequestDiff> {
  const resolution = await resolvePullRequestForReview(
    input.repoPath,
    input.remoteUrl,
    input.pullRequestId,
  );
  return {
    pullRequest: resolution.pullRequest,
    files: resolution.diffFiles,
    summary: {
      ...summarizeDiffFiles(resolution.diffFiles),
      currentCommitSha: resolution.pullRequest.sourceCommitSha,
    },
  };
}

export async function generatePullRequestVisualisation(
  input: GeneratePullRequestVisualisationOptions,
): Promise<PullRequestVisualisation> {
  input.onProgress?.('Resolving pull request changes…');
  const resolution = await resolvePullRequestForReview(
    input.repoPath,
    input.remoteUrl,
    input.pullRequestId,
  );
  const headSha =
    resolution.pullRequest.sourceCommitSha ??
    `${resolution.pullRequest.provider}:${resolution.pullRequest.updatedAt}`;
  const current = getLatestPullRequestVisualisation(input.repoId, input.pullRequestId);

  if (!input.force && current?.status === 'ready' && current.headSha === headSha) {
    return current;
  }

  const pending = beginPullRequestVisualisation({
    repoId: input.repoId,
    reviewId: input.reviewId,
    pullRequest: resolution.pullRequest,
    headSha,
  });

  try {
    input.onProgress?.('Building the change story…');
    const reviewEvidence = input.reviewId
      ? formatReviewEvidence(getFindings(input.reviewId))
      : 'No standard code review is linked to this visualisation.';
    const prompt = loadPromptTemplate('pull-request-visualisation.md', {
      pullRequest: formatPullRequest(resolution.pullRequest),
      repoContext: input.repoContext,
      reviewEvidence,
      diff: buildBoundedDiff(resolution.diffFiles),
    });
    const response = await callLlm(prompt, 8192, 0.2, 3, {
      cwd: input.repoPath,
      taskClass: 'long-context',
      onProgress: input.onProgress,
    });
    const output = parsePullRequestVisualisationResponse(response);
    completePullRequestVisualisation(pending.id, output);
    return getLatestPullRequestVisualisation(input.repoId, input.pullRequestId)!;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failPullRequestVisualisation(pending.id, message);
    throw error;
  }
}

export function parsePullRequestVisualisationResponse(response: string): VisualisationOutput {
  const trimmed = response.trim();
  const fenced = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)?.[1];
  const object = trimmed.match(/\{[\s\S]*\}/)?.[0];
  const candidates = [fenced, object, trimmed].filter((value): value is string => Boolean(value));
  let raw: Record<string, unknown> | null = null;
  for (const candidate of candidates) {
    try {
      raw = JSON.parse(candidate) as Record<string, unknown>;
      break;
    } catch {
      // Try the next candidate.
    }
  }
  if (!raw) throw new Error('The PR visualisation response was not valid JSON.');

  const chapters = arrayOfRecords(raw.chapters)
    .slice(0, 8)
    .map((chapter, index) => ({
      id: cleanId(chapter.id, `chapter-${index + 1}`),
      title: cleanText(chapter.title, `Chapter ${index + 1}`),
      summary: cleanText(chapter.summary, 'Changed behaviour'),
      nodeIds: stringArray(chapter.nodeIds),
      riskCount: safeCount(chapter.riskCount),
      verifiedCount: safeCount(chapter.verifiedCount),
    }));
  const chapterIds = new Set(chapters.map((chapter) => chapter.id));

  const nodes = arrayOfRecords(raw.nodes)
    .slice(0, 32)
    .map((node, index) => ({
      id: cleanId(node.id, `node-${index + 1}`),
      label: cleanText(node.label, `Node ${index + 1}`),
      detail: optionalText(node.detail),
      kind: NODE_KINDS.has(node.kind as PullRequestVisualisationNodeKind)
        ? (node.kind as PullRequestVisualisationNodeKind)
        : 'service',
      tone: parseTone(node.tone),
      changeState: parseChangeState(node.changeState),
      chapterId:
        typeof node.chapterId === 'string' && chapterIds.has(node.chapterId)
          ? node.chapterId
          : undefined,
      filePath: optionalText(node.filePath),
      line: safeLine(node.line),
    }));
  const nodeIds = new Set(nodes.map((node) => node.id));

  const edges = arrayOfRecords(raw.edges)
    .slice(0, 48)
    .map((edge, index) => ({
      id: cleanId(edge.id, `edge-${index + 1}`),
      source: cleanText(edge.source, ''),
      target: cleanText(edge.target, ''),
      label: optionalText(edge.label),
      tone: parseTone(edge.tone),
      changeState: parseChangeState(edge.changeState),
      changed: edge.changed === true,
    }))
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));

  const risks = arrayOfRecords(raw.risks)
    .slice(0, 16)
    .map((risk, index) => ({
      id: cleanId(risk.id, `risk-${index + 1}`),
      title: cleanText(risk.title, 'Review risk'),
      severity:
        risk.severity === 'critical' || risk.severity === 'major' || risk.severity === 'minor'
          ? risk.severity
          : ('unknown' as const),
      explanation: cleanText(risk.explanation, 'This risk needs confirmation.'),
      nodeId: typeof risk.nodeId === 'string' && nodeIds.has(risk.nodeId) ? risk.nodeId : undefined,
      filePath: optionalText(risk.filePath),
      line: safeLine(risk.line),
      evidence: optionalText(risk.evidence),
    }));

  const evidence = arrayOfRecords(raw.evidence)
    .slice(0, 24)
    .map((item, index) => ({
      id: cleanId(item.id, `evidence-${index + 1}`),
      label: cleanText(item.label, 'Review evidence'),
      kind:
        item.kind === 'test' ||
        item.kind === 'finding' ||
        item.kind === 'verification' ||
        item.kind === 'pull_request'
          ? item.kind
          : ('file' as const),
      status:
        item.status === 'verified' || item.status === 'risk' || item.status === 'changed'
          ? item.status
          : ('unknown' as const),
      detail: optionalText(item.detail),
      nodeId: typeof item.nodeId === 'string' && nodeIds.has(item.nodeId) ? item.nodeId : undefined,
      filePath: optionalText(item.filePath),
      line: safeLine(item.line),
    }));

  if (nodes.length === 0) {
    throw new Error('The PR visualisation did not contain any usable nodes.');
  }

  return {
    summary: cleanText(raw.summary, 'Pull request change story'),
    intent: cleanText(raw.intent, 'Intent was not explicit in the pull request.'),
    chapters,
    nodes,
    edges,
    risks,
    evidence,
  };
}

export function buildPullRequestVisualisationMarkdown(
  visualisation: PullRequestVisualisation,
): string {
  const pr = visualisation.pullRequest;
  const story = visualisation.chapters
    .map(
      (chapter, index) =>
        `### ${index + 1}. ${chapter.title}\n\n${chapter.summary}\n\n` +
        `- Risks: ${chapter.riskCount}\n- Verified evidence: ${chapter.verifiedCount}`,
    )
    .join('\n\n');
  const nodes = visualisation.nodes
    .map((node) => `  ${mermaidId(node.id)}["${mermaidLabel(node.label)}"]`)
    .join('\n');
  const edges = visualisation.edges
    .map(
      (edge) =>
        `  ${mermaidId(edge.source)} -->${edge.label ? `|${mermaidLabel(edge.label)}|` : ''} ${mermaidId(edge.target)}`,
    )
    .join('\n');
  const risks = visualisation.risks.length
    ? visualisation.risks
        .map(
          (risk) =>
            `- **${risk.severity.toUpperCase()} — ${risk.title}:** ${risk.explanation}${
              risk.filePath ? ` (${risk.filePath}${risk.line ? `:${risk.line}` : ''})` : ''
            }`,
        )
        .join('\n')
    : '- No risks were identified.';
  const evidence = visualisation.evidence.length
    ? visualisation.evidence
        .map(
          (item) =>
            `- **${item.status} · ${item.label}**${item.detail ? ` — ${item.detail}` : ''}${
              item.filePath ? ` (${item.filePath}${item.line ? `:${item.line}` : ''})` : ''
            }`,
        )
        .join('\n')
    : '- No linked evidence.';

  return [
    `# PR #${pr.id}: ${pr.title}`,
    '',
    `> ${visualisation.summary ?? 'Pull request change story'}`,
    '',
    `**Intent:** ${visualisation.intent ?? 'Not stated'}`,
    '',
    `**Branches:** \`${pr.sourceBranch}\` → \`${pr.targetBranch}\`  `,
    `**Head:** \`${visualisation.headSha}\`  `,
    `**Generated:** ${visualisation.generatedAt ?? visualisation.createdAt}`,
    '',
    '## System map',
    '',
    '```mermaid',
    'flowchart LR',
    nodes,
    edges,
    '```',
    '',
    '## Change story',
    '',
    story || 'No chapters were generated.',
    '',
    '## Risks',
    '',
    risks,
    '',
    '## Evidence',
    '',
    evidence,
    '',
  ].join('\n');
}

function mermaidId(value: string): string {
  return `node_${value.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

function mermaidLabel(value: string): string {
  return value.replace(/["|]/g, '').replace(/\s+/g, ' ').trim();
}

function formatPullRequest(pullRequest: CodeReviewPullRequest): string {
  return [
    `#${pullRequest.id} ${pullRequest.title}`,
    `Provider: ${pullRequest.provider}`,
    `Author: ${pullRequest.author ?? 'unknown'}`,
    `Branches: ${pullRequest.sourceBranch} → ${pullRequest.targetBranch}`,
    `Head SHA: ${pullRequest.sourceCommitSha ?? 'unknown'}`,
    '',
    pullRequest.description?.trim() || 'No pull request description was provided.',
  ].join('\n');
}

function formatReviewEvidence(findings: CodeReviewFinding[]): string {
  if (findings.length === 0) return 'The linked review contains no findings.';
  return findings
    .filter((finding) => !finding.dismissed)
    .slice(0, 40)
    .map(
      (finding) =>
        `- [${finding.severity}] ${finding.category}: ${finding.description}${
          finding.filePath
            ? ` (${finding.filePath}${finding.lineStart ? `:${finding.lineStart}` : ''})`
            : ''
        }`,
    )
    .join('\n');
}

function buildBoundedDiff(files: GitDiffFile[]): string {
  let remaining = MAX_VISUALISATION_DIFF_CHARS;
  const parts: string[] = [];
  for (const file of files) {
    if (remaining <= 0) break;
    const header = `\n\n## ${file.filePath} (${file.status})\n`;
    const slice = file.diff.slice(0, Math.max(0, remaining - header.length));
    parts.push(header, slice);
    remaining -= header.length + slice.length;
  }
  if (files.length > 0 && remaining <= 0) {
    parts.push('\n\n[Diff truncated to the visualisation context limit.]');
  }
  return parts.join('').trim();
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object',
      )
    : [];
}

function cleanId(value: unknown, fallback: string): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
}

function cleanText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    : [];
}

function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function safeLine(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function parseTone(value: unknown): PullRequestVisualisationTone {
  return TONES.has(value as PullRequestVisualisationTone)
    ? (value as PullRequestVisualisationTone)
    : 'neutral';
}

function parseChangeState(value: unknown): PullRequestVisualisationChangeState {
  return CHANGE_STATES.has(value as PullRequestVisualisationChangeState)
    ? (value as PullRequestVisualisationChangeState)
    : 'both';
}

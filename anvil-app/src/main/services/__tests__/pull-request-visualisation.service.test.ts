import { describe, expect, it } from 'vitest';
import {
  buildPullRequestVisualisationMarkdown,
  parsePullRequestVisualisationResponse,
} from '../pull-request-visualisation.service.js';

describe('parsePullRequestVisualisationResponse', () => {
  it('normalises a grounded change story and removes invalid relationships', () => {
    const result = parsePullRequestVisualisationResponse(`
      \`\`\`json
      {
        "summary": "Routes requests through the new policy service.",
        "intent": "Centralise permission checks.",
        "chapters": [{
          "id": "Policy path",
          "title": "Policy path",
          "summary": "Requests now cross the policy boundary.",
          "nodeIds": ["controller", "policy"],
          "riskCount": 1,
          "verifiedCount": 2
        }],
        "nodes": [
          {"id": "controller", "label": "Controller", "kind": "entry", "tone": "action", "changeState": "both", "chapterId": "policy-path", "filePath": "src/controller.ts", "line": 12},
          {"id": "policy", "label": "Policy", "kind": "service", "tone": "logic", "changeState": "after", "chapterId": "policy-path"}
        ],
        "edges": [
          {"id": "valid", "source": "controller", "target": "policy", "tone": "action", "changeState": "after", "changed": true},
          {"id": "invalid", "source": "missing", "target": "policy", "tone": "risk", "changeState": "after", "changed": true}
        ],
        "risks": [{"id": "risk-1", "title": "Policy bypass", "severity": "major", "explanation": "Legacy entry points may bypass checks.", "nodeId": "policy"}],
        "evidence": [{"id": "test-1", "label": "Policy tests", "kind": "test", "status": "verified", "nodeId": "policy"}]
      }
      \`\`\`
    `);

    expect(result.summary).toBe('Routes requests through the new policy service.');
    expect(result.chapters[0].id).toBe('policy-path');
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({ source: 'controller', target: 'policy' });
    expect(result.risks[0]).toMatchObject({ severity: 'major', nodeId: 'policy' });
    expect(result.evidence[0]).toMatchObject({ status: 'verified', nodeId: 'policy' });

    const markdown = buildPullRequestVisualisationMarkdown({
      id: 'visualisation-1',
      repoId: 'repo-1',
      pullRequest: {
        id: '42',
        title: 'Add policy service',
        provider: 'github',
        state: 'open',
        isDraft: false,
        sourceBranch: 'feature/policy',
        targetBranch: 'main',
        updatedAt: '2026-08-07T10:00:00.000Z',
      },
      headSha: 'abcdef123456',
      status: 'ready',
      createdAt: '2026-08-07T10:00:00.000Z',
      ...result,
    });
    expect(markdown).toContain('# PR #42: Add policy service');
    expect(markdown).toContain('```mermaid');
    expect(markdown).toContain('node_controller -->');
  });

  it('rejects responses without usable nodes', () => {
    expect(() => parsePullRequestVisualisationResponse('{"summary":"Empty","nodes":[]}')).toThrow(
      'did not contain any usable nodes',
    );
  });

  it('rejects non-JSON model output', () => {
    expect(() => parsePullRequestVisualisationResponse('No structured output')).toThrow(
      'was not valid JSON',
    );
  });
});

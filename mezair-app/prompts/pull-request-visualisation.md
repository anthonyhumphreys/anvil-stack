You are building a precise interactive visual explanation of a pull request for a senior developer.

## Pull request

{{pullRequest}}

## Repository context

{{repoContext}}

## Existing review evidence

{{reviewEvidence}}

## Diff

{{diff}}

Return one JSON object matching this shape exactly:

{
"summary": "Concise explanation of the material change",
"intent": "The intended product or engineering outcome, including explicit uncertainty",
"chapters": [
{
"id": "stable-kebab-id",
"title": "Short behaviour-oriented title",
"summary": "What changes in this chapter and why it matters",
"nodeIds": ["node-id"],
"riskCount": 0,
"verifiedCount": 0
}
],
"nodes": [
{
"id": "stable-kebab-id",
"label": "Short system label",
"detail": "One useful sentence",
"kind": "entry | service | data | file | test | external | risk",
"tone": "neutral | action | data | verified | risk | logic | uncertainty",
"changeState": "before | after | both",
"chapterId": "chapter-id",
"filePath": "path when grounded in a file",
"line": 42
}
],
"edges": [
{
"id": "edge-id",
"source": "node-id",
"target": "node-id",
"label": "Short causal relationship",
"tone": "neutral | action | data | verified | risk | logic | uncertainty",
"changeState": "before | after | both",
"changed": true
}
],
"risks": [
{
"id": "risk-id",
"title": "Concrete risk",
"severity": "critical | major | minor | unknown",
"explanation": "Why this can fail",
"nodeId": "related-node",
"filePath": "path",
"line": 42,
"evidence": "Evidence or explicit inference"
}
],
"evidence": [
{
"id": "evidence-id",
"label": "Short evidence label",
"kind": "file | test | finding | verification | pull_request",
"status": "verified | risk | changed | unknown",
"detail": "Why it supports the explanation",
"nodeId": "related-node",
"filePath": "path",
"line": 42
}
]
}

Rules:

- Explain both what the code does and the intended outcome from the PR description and commits.
- Group by behaviour or subsystem, never by arbitrary file batches.
- Produce 3-7 chapters and 5-24 nodes. Prefer clarity over graph size.
- Include before/after structure only where logic, state, permissions, data flow, or architecture materially changes.
- Every edge must reference emitted node IDs.
- Ground paths and line numbers in the supplied diff. Do not invent them.
- Treat inferred intent, blast radius, or risk as uncertainty unless evidence supports it.
- Tests and verification are evidence, not proof beyond what they exercise.
- Output JSON only. No Markdown fence or preamble.

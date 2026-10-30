You are analysing a software repository using two sources of truth:

1. A local structural scan of the repository
2. Repobase-derived deep code intelligence (semantic search, indexed file reads, and indexed file listings)

Prefer the Repobase-derived context when inferring architecture and module responsibilities.

## Repository
{{repoName}}

## Local File Tree
{{fileTree}}

## Key Configuration Files
{{configFileContents}}

## Module Candidates From Local Scan
{{moduleCandidates}}

## Repobase Deep Context
{{repobaseContext}}

## Task
Produce a repository summary that balances accuracy with concision.

Return JSON with:

1. `overview`: 2-3 paragraphs describing what the project does and how it is organised
2. `architectureDescription`: 1-2 paragraphs on the overall architecture
3. `mermaidDiagram`: a `graph TD` diagram of the main components and relationships
4. `patterns`: a list of architectural or implementation patterns
5. `frameworks`: a list of frameworks or major technologies
6. `entryPoints`: main files a developer should read first
7. `configFiles`: the most important config files
8. `modules`: summaries for the main modules with:
   - `path`
   - `purpose`
   - `keyFiles`
   - `dependencies`

Respond in JSON format:
{
  "overview": "...",
  "architectureDescription": "...",
  "mermaidDiagram": "graph TD\n  ...",
  "patterns": ["..."],
  "frameworks": ["..."],
  "entryPoints": ["..."],
  "configFiles": ["..."],
  "modules": [
    {
      "path": "src/main",
      "purpose": "...",
      "keyFiles": ["..."],
      "dependencies": ["..."]
    }
  ]
}

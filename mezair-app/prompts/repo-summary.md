You are analysing a software repository for independent delivery teams.

## Repository Structure
{{fileTree}}

## Key Configuration Files
{{configFileContents}}

## Module Summaries
{{moduleSummaries}}

## Task
Provide a comprehensive repository analysis:

1. **Overview** (2-3 paragraphs): What this project does, its role in the delivery ecosystem, and its technical approach.

2. **Architecture Description** (1-2 paragraphs): The overall architectural pattern, how components interact, and key design decisions.

3. **Mermaid Diagram**: A graph TD diagram showing the major components and their relationships. Include:
   - Services/APIs as rectangles
   - Databases as cylinders
   - External systems as rounded rectangles
   - Label edges with protocol/method (REST, gRPC, SQL, etc.)

4. **Detected Patterns**: List architectural and design patterns observed (e.g. "Repository pattern", "Event sourcing", "CQRS").

5. **Key Entry Points**: List the main files a developer should start reading.

6. **Configuration Files**: List important config files and what they control.

Respond in JSON format:
{
  "overview": "...",
  "architectureDescription": "...",
  "mermaidDiagram": "graph TD\n  ...",
  "patterns": ["..."],
  "frameworks": ["..."],
  "entryPoints": ["..."],
  "configFiles": ["..."]
}

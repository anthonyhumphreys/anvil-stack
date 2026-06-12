You are analysing a module within a software repository.

## Module: {{modulePath}}
## Repository: {{repoName}}

## Directory Contents
{{directoryTree}}

## Key File Contents
{{keyFileContents}}

## Task
Analyse this module and provide:

1. **Purpose**: One paragraph describing what this module does and its role in the project.
2. **Key Files**: The 3-5 most important files and what each does.
3. **Dependencies**: Which other modules/packages this module depends on.

Respond in JSON format:
{
  "purpose": "...",
  "keyFiles": ["..."],
  "dependencies": ["..."]
}

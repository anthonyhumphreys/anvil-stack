You are generating a .devcontainer/devcontainer.json configuration for a software repository.

## Repository: {{repoName}}

### Detected Languages
{{languages}}

### Detected Frameworks
{{frameworks}}

### Config Files Found
{{configFiles}}

---

Generate a devcontainer.json configuration that:
1. Uses an appropriate base image for the primary language/framework
2. Includes relevant VS Code extensions
3. Configures any necessary ports
4. Includes post-create commands for dependency installation
5. Sets useful VS Code settings

Common base images:
- Node.js: mcr.microsoft.com/devcontainers/javascript-node:20
- .NET: mcr.microsoft.com/devcontainers/dotnet:8.0
- Python: mcr.microsoft.com/devcontainers/python:3.12
- Go: mcr.microsoft.com/devcontainers/go:1.22
- Java: mcr.microsoft.com/devcontainers/java:21
- Universal: mcr.microsoft.com/devcontainers/universal:2

Output ONLY valid JSON. Do not wrap in code fences. Do not add any preamble or explanation.

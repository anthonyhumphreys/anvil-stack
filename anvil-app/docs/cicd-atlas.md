# CI/CD Atlas

The CI/CD Atlas reads GitHub Actions workflows and Azure Pipelines YAML files in the selected repository. It maps workflow, stage, job, step, dependency, and environment-gate relationships, then reports YAML and structure findings.

The Templates view scans the repository for deterministic stack evidence. It recognizes Node package manifests, lockfiles, root and workspace scripts, common framework dependencies, workspace configuration, Python project files, `go.mod`, `Cargo.toml`, and .NET project files. Recommendations show their rank, the evidence used, and the commands the generated starter will run.

Node starters select pnpm, npm, Yarn, or Bun from `packageManager` and lockfiles. They include only detected root scripts named `lint`, `typecheck`, `test`, or `build`, plus workspace commands when those scripts exist in a package. Python starters install from `requirements.txt`, `pyproject.toml`, `setup.py`, or Pipenv. They add pytest only when the installed project dependencies include pytest or a `test` extra installs it. Go, Rust, and .NET starters use their repository-native test commands and detected project or SDK paths. Unknown stacks get a GitHub Actions skeleton with checkout and no guessed build command.

Anvil writes a workflow only after the user selects **Create file**. It preserves an existing file by refusing to overwrite it, validates the relative YAML path, rejects symlinked parent directories, and quotes dynamic YAML values. Generated workflows do not deploy externally. The gated release starter includes placeholder build, security, and deployment steps. Its production environment hook pauses for approval only after required reviewers are configured in GitHub environment settings.

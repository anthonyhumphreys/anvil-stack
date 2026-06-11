# @anvil-cloud/builder

Compiler and bundler package for Anvil Cloud.

Responsibilities:

- load `anvil.json`;
- validate Cell project structure;
- run type and import checks;
- bundle server and client entrypoints;
- extract `manifest.json`;
- generate client API metadata.

See `docs/architecture/builder.md` for the implementation design.

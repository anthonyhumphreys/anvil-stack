---
title: Database guide
navTitle: Persistence
description: How Anvil Desktop uses SQLite, schema migrations, and workspace-scoped data storage.
product: Anvil Desktop
section: Engineering
journey: reference
order: 106
---

# Database guide

Anvil Desktop stores workspace state, chat history, review findings, automation results, and connector settings in a local SQLite database. The main process owns all database access; the renderer receives data through the preload bridge.

## Schema location

Schema definition, current version, and incremental migrations live in:

```txt
src/main/db/schema.ts
```

Database startup and migration execution live in:

```txt
src/main/db/database.ts
```

## Making schema changes

1. Increment `SCHEMA_VERSION` in `schema.ts`.
2. Add a new migration entry to the `MIGRATIONS` array.
3. Update services that read or write the affected tables.
4. Add focused tests for migration behaviour and service logic.
5. Do not rewrite old migrations in place.

Migrations run automatically on app startup before any service accesses the database.

## Key tables

| Table | Purpose |
| --- | --- |
| `repos` | Repository metadata and indexing state. |
| `workspaces` | Workspace definitions and preferences. |
| `chat_threads` | Chat session headers and provider config. |
| `chat_messages` | Individual messages with role and content. |
| `code_reviews` | Review runs and summary status. |
| `code_review_findings` | Individual findings with severity and file refs. |
| `security_audits` | Security audit runs. |
| `security_findings` | Security findings with OWASP/CWE mapping. |
| `work_items_cache` | Cached work items from Linear, Jira, Azure DevOps. |
| `settings` | App settings with encrypted credentials. |
| `lifecycle_items` | Lifecycle gates and readiness checks. |
| `automation_definitions` | Automation rules and schedules. |
| `automation_runs` | Automation execution history. |

The full schema includes 77 tables. Inspect `schema.ts` for the complete list.

## WAL mode

The database runs with WAL (Write-Ahead Logging) for better concurrency between the main process and any background operations. WAL keeps readers from blocking writers.

## Backup and portability

The SQLite file lives in Anvil Desktop's application support directory:

```txt
macOS: ~/Library/Application Support/Anvil/anvil.db
```

You can back up the database by copying the file while the app is closed. Do not copy it while the app is running unless you also copy the `-wal` and `-shm` files.

## Encryption

Sensitive columns such as API keys and connector tokens are encrypted before storage. The encryption key is derived from the system keychain where available. This is not a substitute for proper secret management in production CI, but it keeps credentials from sitting in plain text on disk.

## Limitations

- SQLite is not a multi-user database. Concurrent access from multiple Anvil Desktop instances to the same database file can cause corruption.
- There is no built-in cloud sync for the database. Workspace portability depends on local file copies.
- Very large chat histories or attachment blobs may grow the database file. Prune old sessions where retention policy requires it.

## Read next

- [Architecture](/docs/desktop/architecture)
- [Extending Anvil Desktop](/docs/desktop/extending-anvil)

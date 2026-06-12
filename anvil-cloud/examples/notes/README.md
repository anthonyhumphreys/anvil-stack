# Notes Cell Example

This example will become the first end-to-end Anvil Cell.

Target alpha behaviour:

- define a `notes` table;
- list notes owned by the current user;
- create notes through a mutation;
- run locally with `anvil dev`;
- inspect local database state with `anvil db dump notes --local --json`.

Implementation should wait until the runtime DSL and local runtime are available.

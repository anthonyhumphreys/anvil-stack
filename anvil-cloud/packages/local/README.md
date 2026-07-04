# @anvil-cloud/local

Local development runtime package for Anvil Cloud.

Responsibilities:

- run the local runtime server;
- serve built client output and proxy runtime routes during local dev;
- provide local database adapters;
- provide local auth, files, jobs, and logs adapters;
- expose local inspection routes;
- support `anvil-cloud dev` and `anvil-cloud inspect --local`.

See `docs/architecture/local-dev.md` for the implementation design.

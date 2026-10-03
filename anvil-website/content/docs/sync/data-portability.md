---
title: Data portability and deletion
navTitle: Portability and deletion
description: Export your synced entities to a portable document, import with staged conflict detection, and delete hosted account data with a visible status.
product: Anvil Sync & Mesh
section: Guides
journey: build
order: 80
---

# Data portability and deletion

Your synced data is yours in both directions: out as a portable document,
back in through a staged import, and off the backend entirely when you delete
the account. One honest caveat up front: **exports are currently sealed
ciphertext**, so they round-trip but are not human-readable. Details below.

## Export

The export path pages your entities out of the backend — `data.export.begin`
starts an operation, `data.export.page` walks it — and the client writes a
portable JSON document:

```json
{
  "formatVersion": 1,
  "epoch": 0,
  "entities": []
}
```

- `formatVersion` — the document schema; bumping it is how importers know
  what they are looking at.
- `epoch` — the export's position in account history.
- `entities` — every synced entity in the account.

The app offers the document through a save dialog (Settings → Sync & Mesh →
Your data). Export is a paged operation, so large accounts stream rather than
load everything at once.

### The ciphertext caveat

Entity payloads in an export are the **sealed envelopes** — the same
ciphertext the backend stores. Consequences:

- The file **round-trips correctly**: import it into an account that holds
  the ADK and every entity restores exactly.
- The file is **not human-readable**: you cannot open it and read your
  workspace definitions as JSON. There is no accidental plaintext leak in
  your downloads folder either — the trade is honest in both directions.
- Unsealing at export time is a **known follow-up**. When it lands, exports
  become real portability documents rather than encrypted backups.

## Import

Import is staged — nothing applies until you say so:

1. **Preview** (`data.import.preview`) — the backend classifies every entity
   in the document: **creates** (new), **unchanged** (already current),
   **conflicts** (divergent from local state), **invalid** (malformed or
   unrecognizable). You see the counts and the lists before anything moves.
2. **Commit** (`data.import.commit`) — applies the import. Always explicit;
   an import never silently overwrites divergent data. Conflicts surface the
   same way sync conflicts do — recorded, listed, resolved by you.

The preview/commit split is the same contract the conformance suite checks,
so a conformant backend behaves identically.

## Account deletion

Deletion is a durable, staged operation — not a flag flip:

1. **Enrollments disable first** — every device loses access before any data
   is touched. Sessions sever; nothing can write to a deleting account.
2. **Hosted data purges in bounded passes** — entities, journals, artifacts,
   billing records, each in bounded batches rather than one unbounded delete.
3. **Status is visible** — `/account/data` shows the deletion status as it
   progresses. Deletion finishing signs every enrolled device out.

Because exports are ciphertext and deletion removes the hosted copies, the
local devices' plaintext domain stores are the only readable copies once
deletion completes — export does not give you a readable archive today.

## Current limits

- Exports are sealed ciphertext: round-trips, not readability. Unseal-at-
  export is tracked follow-up work.
- Import requires the target account to hold the ADK the export was sealed
  under; a document sealed under a key you no longer have is a file of
  unreadable envelopes.
- Deletion purges hosted state; local copies on enrolled devices are the
  survivor. There is no "delete everywhere including devices" — the backend
  cannot reach device-local stores.

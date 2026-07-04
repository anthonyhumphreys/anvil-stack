import type { Note } from "../cell.server.js";

declare module "@anvil/generated/client" {
  interface QueryTypes {
    status: {
      input: unknown;
      result: {
        ok: boolean;
        cell: string;
        requestId: string;
      };
    };
    listNotes: {
      input: unknown;
      result: Note[];
    };
  }

  interface MutationTypes {
    createNote: {
      input: {
        title: string;
        body?: string;
      };
      result: Note;
    };
    archiveNote: {
      input: {
        noteId: string;
      };
      result: {
        archived: boolean;
      };
    };
  }
}

export {};

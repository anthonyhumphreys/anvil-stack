import { describe, expect, it } from "vitest";

import { AwsEventBridgeEventAdapter } from "../src/host.js";

describe("AwsEventBridgeEventAdapter", () => {
  it("publishes events to the configured bus", async () => {
    const sent: unknown[] = [];
    const adapter = new AwsEventBridgeEventAdapter({
      client: {
        send: async (command: unknown) => {
          sent.push(command);
          return { FailedEntryCount: 0, Entries: [{ EventId: "evt_1" }] };
        },
      } as never,
      eventBusName: "anvil-notes-preview-events",
      source: "anvil.cell.notes",
    });

    await adapter.publish("note.created", { noteId: "note_1" });

    expect(sent).toHaveLength(1);

    const input = (sent[0] as { input: { Entries: unknown[] } }).input;

    expect(input.Entries[0]).toMatchObject({
      EventBusName: "anvil-notes-preview-events",
      Source: "anvil.cell.notes",
      DetailType: "note.created",
      Detail: JSON.stringify({ noteId: "note_1" }),
    });
  });

  it("throws an adapter error when EventBridge reports failures", async () => {
    const adapter = new AwsEventBridgeEventAdapter({
      client: {
        send: async () => ({
          FailedEntryCount: 1,
          Entries: [
            { ErrorCode: "ThrottlingException", ErrorMessage: "slow down" },
          ],
        }),
      } as never,
      eventBusName: "bus",
      source: "anvil.cell.notes",
    });

    await expect(adapter.publish("note.created", {})).rejects.toMatchObject({
      code: "ADAPTER_ERROR",
      status: 502,
      details: {
        name: "note.created",
        errorCode: "ThrottlingException",
        errorMessage: "slow down",
      },
    });
  });
});

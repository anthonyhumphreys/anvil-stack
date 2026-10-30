/**
 * The real session handoff states, in order (mezair-app cloud/contract/handoff.ts,
 * HANDOFF_TRANSITIONS). Cancelled and failed can follow any non-terminal state.
 */
export const handoffSteps = [
  { state: "requested", label: "Requested" },
  { state: "target-prepared-without-execution", label: "Preparing" },
  { state: "source-quiescing", label: "Pausing" },
  { state: "source-relinquished-and-checkpointed", label: "Sealed" },
  { state: "ownership-transferred", label: "Transferred" },
  { state: "target-activating", label: "Resuming" },
  { state: "completed", label: "Running" }
] as const;

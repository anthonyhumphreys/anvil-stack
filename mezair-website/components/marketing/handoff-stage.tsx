import { Laptop, LockKeyhole, Monitor } from "lucide-react";

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

export const handoffSummary =
  "The MacBook pauses the session and seals its progress before transferring ownership to studio-mac, which resumes the work.";

/** Maps scene progress (0 to 1) to a step, holding on completed for the final stretch. */
export function handoffStepAt(progress: number) {
  return Math.min(handoffSteps.length - 1, Math.floor(progress * 8.2));
}

/** The words Desktop's session chip shows at each step ("Session on …"). */
export function sessionOwnerLabel(step: number) {
  if (step >= handoffSteps.length - 1) return "studio-mac";
  return step < 4 ? "This MacBook, preparing handoff" : "studio-mac, resuming";
}

function sourceStatus(step: number) {
  if (step <= 1) return "owns the session";
  if (step === 2) return "pausing";
  if (step === 3) return "checkpointed";
  return "relinquished";
}

function targetStatus(step: number) {
  if (step === 0) return "idle";
  if (step <= 3) return "prepared, not running";
  if (step === 4) return "owns the session";
  if (step === 5) return "activating";
  return "running the session";
}

/**
 * Two of your machines and the sealed checkpoint between them. Pure and
 * static for a given step; the scene that hosts it decides when steps advance.
 */
export function HandoffStage({ step, size = "compact" }: { step: number; size?: "compact" | "full" }) {
  const packet = step >= 3 && step <= 5;
  const travel = step >= 4 ? 1 : 0;
  const sourceOwns = step <= 3;

  return (
    <div className="ho" data-size={size} data-packet={packet ? "on" : "off"} style={{ "--t": travel } as React.CSSProperties}>
      <div className="ho-track">
        <div className="ho-device" data-owner={sourceOwns ? "true" : "false"}>
          <p className="ho-device-name">
            <Laptop className="size-3.5" aria-hidden="true" />
            <span className="sc-trunc">This MacBook</span>
          </p>
          <p className="ho-device-status">
            <span className="ho-owner-dot" aria-hidden="true" />
            {sourceStatus(step)}
          </p>
          <div className="ho-device-thread">
            <p>Retry limit on flaky networks</p>
            <p>{sourceOwns ? "Progress stays here until the checkpoint is safe." : "Session on studio-mac."}</p>
          </div>
        </div>

        <div className="ho-wire">
          <span className="ho-packet">
            <LockKeyhole className="size-3" aria-hidden="true" />
            <span className="ho-packet-word">checkpoint,</span> sealed
          </span>
          <p className="ho-backend">Your Sync backend<br />carries it, can&apos;t read it</p>
        </div>

        <div className="ho-device" data-owner={sourceOwns ? "false" : "true"}>
          <p className="ho-device-name">
            <Monitor className="size-3.5" aria-hidden="true" />
            <span className="sc-trunc">studio-mac</span>
          </p>
          <p className="ho-device-status">
            <span className="ho-owner-dot" aria-hidden="true" />
            {targetStatus(step)}
          </p>
          <div className="ho-device-thread">
            <p>Retry limit on flaky networks</p>
            <p>{step >= 6 ? "Session resumed here." : step >= 1 ? "Workspace prepared and checked." : "Trusted device, idle."}</p>
          </div>
        </div>
      </div>

      <ol className="ho-steps">
        {handoffSteps.map((item, index) => (
          <li
            key={item.state}
            className="ho-step"
            data-phase={index < step || step === handoffSteps.length - 1 ? "done" : index === step ? "now" : "next"}
            aria-current={index === step ? "step" : undefined}
          >
            <span>{item.label}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

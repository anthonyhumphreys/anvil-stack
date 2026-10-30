"use client";

import { useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import {
  Check,
  ChevronRight,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequestArrow,
  Laptop,
  Monitor,
  Paperclip,
  Pause,
  Pencil,
  Play,
  Send,
  ShieldCheck,
  Terminal
} from "lucide-react";
import { HandoffStage, handoffStepAt, handoffSteps, handoffSummary, sessionOwnerLabel } from "./handoff-stage";
import { useReel } from "./use-reel";

const TASK = "Retries give up too early on flaky networks. Raise the limit to 5 and add a test that proves it.";

const chapters = [
  {
    id: "task",
    label: "Task",
    hint: "Say what you want",
    summary: `Illustrative demo of Mezair Desktop. The mezair-stack repo is open on main, and the composer holds a task for Codex: ${TASK}`
  },
  {
    id: "work",
    label: "Agent work",
    hint: "Watch every step",
    summary:
      "Codex is working on the branch fix/retry-limit. The activity panel lists each step as it happens: read src/retry.ts, ran pnpm test retry with one failure, edited src/retry.ts, and is running pnpm test."
  },
  {
    id: "review",
    label: "Review",
    hint: "Judge the change",
    summary:
      "Work completed in 4 actions. pnpm test reports 14 passed, the diff raises MAX_ATTEMPTS from 3 to 5 and adds a test, and the changes footer offers Commit and Open pull request."
  },
  {
    id: "handoff",
    label: "Handoff",
    hint: "Move machines",
    summary: `The branch is committed and pushed. ${handoffSummary}`
  }
] as const;

const REEL_DURATIONS = [5200, 7600, 6400, 9800] as const;
const HANDOFF_DURATIONS = [12000] as const;

const files = [
  { path: "src/retry.ts", note: "in the task" },
  { path: "src/retry.test.ts", note: "" },
  { path: "src/http/client.ts", note: "" },
  { path: "package.json", note: "" }
] as const;

const activity = [
  { icon: FileText, done: "Read", live: "Reading", target: "src/retry.ts", result: "", tone: "add" },
  { icon: Terminal, done: "Ran", live: "Running", target: "pnpm test retry", result: "1 failed", tone: "del" },
  { icon: Pencil, done: "Edited", live: "Editing", target: "src/retry.ts", result: "+1 −1", tone: "add" },
  { icon: Terminal, done: "Ran", live: "Running", target: "pnpm test", result: "14 passed", tone: "add" }
] as const;

function PlayToggle({ playing, onToggle, className }: { playing: boolean; onToggle: () => void; className?: string }) {
  return (
    <button
      type="button"
      className={className ? `reel-toggle ${className}` : "reel-toggle"}
      onClick={onToggle}
      aria-label={playing ? "Pause the demo" : "Play the demo"}
    >
      {playing ? <Pause className="size-4" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
    </button>
  );
}

/**
 * The homepage's projected scene: an authored, illustrative Mezair Desktop
 * window that plays a job from task to handoff. Visitors pick a chapter from
 * the reel; autoplay stops on any choice, offscreen and under reduced motion.
 */
export function ProductReel() {
  const { rootRef, chapter, progress, barProgress, motion, reduced, playing, select, toggle } = useReel(REEL_DURATIONS);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const current = chapters[chapter];

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const last = chapters.length - 1;
    let next: number | null = null;
    if (event.key === "ArrowRight") next = chapter === last ? 0 : chapter + 1;
    else if (event.key === "ArrowLeft") next = chapter === 0 ? last : chapter - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next === null) return;
    event.preventDefault();
    select(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <div ref={rootRef} data-motion={motion ? "on" : "off"}>
      <div
        role="tabpanel"
        id="reel-panel"
        aria-labelledby={`reel-tab-${current.id}`}
        tabIndex={0}
        className="cine-rise rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
      >
        <p className="sr-only">{current.summary}</p>
        <div aria-hidden="true">
          <SceneWindow chapter={chapter} progress={progress} />
        </div>
      </div>

      <div className="reel">
        <div role="tablist" aria-label="Demo chapters" className="reel-tabs" onKeyDown={onKeyDown}>
          {chapters.map((item, index) => {
            const selected = index === chapter;
            return (
              <button
                key={item.id}
                ref={(element) => {
                  tabRefs.current[index] = element;
                }}
                type="button"
                role="tab"
                id={`reel-tab-${item.id}`}
                aria-selected={selected}
                aria-controls="reel-panel"
                tabIndex={selected ? 0 : -1}
                className="reel-tab"
                onClick={() => select(index)}
              >
                <span
                  className="reel-bar"
                  style={{ "--p": selected ? barProgress : 0 } as CSSProperties}
                  aria-hidden="true"
                />
                <span className="reel-tab-label">{item.label}</span>
                <span className="reel-tab-hint">{item.hint}</span>
              </button>
            );
          })}
        </div>
        {reduced ? null : <PlayToggle playing={playing} onToggle={toggle} />}
      </div>

      <p className="cine-fine mt-3">
        Illustrative demo with an example repository, task and devices.
      </p>
    </div>
  );
}

/** The /sync hero: a session moving between two of your machines through the real handoff states. */
export function HandoffScene() {
  const { rootRef, progress, motion, reduced, playing, toggle } = useReel(HANDOFF_DURATIONS);
  const step = handoffStepAt(progress);

  return (
    <div ref={rootRef} data-motion={motion ? "on" : "off"}>
      <figure className="cine-rise">
        <div className="ho-stage">
          <div className="mb-5 flex items-center justify-between gap-4">
            <p className="flex min-w-0 items-center gap-2 text-sm text-[oklch(var(--artifact-dim))]">
              <Laptop className="size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0">
                Session on{" "}
                <strong className="font-medium text-[oklch(var(--artifact-text))]">{sessionOwnerLabel(step)}</strong>
              </span>
            </p>
            {reduced ? null : <PlayToggle playing={playing} onToggle={toggle} className="shrink-0" />}
          </div>
          <HandoffStage step={step} size="full" />
        </div>
        <figcaption className="cine-fine mt-4">
          Illustrative handoff between example devices. Save and push your changes before moving a session.
        </figcaption>
      </figure>
    </div>
  );
}

function Reveal({ on, children }: { on: boolean; children: ReactNode }) {
  return (
    <div className="sc-reveal" data-on={on ? "true" : "false"}>
      <div>{children}</div>
    </div>
  );
}

function SceneWindow({ chapter, progress }: { chapter: number; progress: number }) {
  const working = chapter === 1;
  const rows = working ? Math.min(activity.length, 1 + Math.floor(progress * activity.length)) : activity.length;
  const liveRow = working ? rows - 1 : -1;
  const step = chapter === 3 ? handoffStepAt(progress) : 0;
  const handedOver = chapter === 3 && step === handoffSteps.length - 1;
  const threadTone = chapter === 0 ? "idle" : working ? "working" : "ok";
  const threadState = chapter === 0 ? "Idle" : working ? "Working" : "Ready to archive";
  const workerStatus = chapter !== 3 ? "idle" : handedOver ? "running" : step >= 4 ? "resuming" : step >= 1 ? "preparing" : "ready";

  return (
    <div className="sc-win">
      <div className="sc-titlebar">
        <span className="sc-lights">
          <span />
          <span />
          <span />
        </span>
        <span className="sc-wintitle">Mezair</span>
        <span className="sc-trunc">mezair-stack</span>
        <span className="sc-branch">
          <GitBranch className="size-3" />
          {chapter === 0 ? "main" : "fix/retry-limit"}
        </span>
      </div>

      <div className="sc-body">
        <aside className="sc-rail">
          <p className="sc-rail-label">Threads</p>
          <ul className="grid gap-0.5">
            <li className="sc-thread" data-current="true">
              <span className="sc-dot" data-tone={threadTone} />
              <span className="sc-thread-name">{chapter === 0 ? "New thread" : "Retry limit on flaky networks"}</span>
              <span className="sc-thread-state" data-tone={threadTone}>
                {threadState}
              </span>
            </li>
            <li className="sc-thread">
              <span className="sc-dot" data-tone="ok" />
              <span className="sc-thread-name">Login redirect loop</span>
              <span className="sc-thread-state" data-tone="ok">
                Ready to archive
              </span>
            </li>
            <li className="sc-thread">
              <span className="sc-dot" data-tone="warn" />
              <span className="sc-thread-name">Docs for the CLI flags</span>
              <span className="sc-thread-state" data-tone="warn">
                Input needed
              </span>
            </li>
          </ul>
          <div className="sc-devices">
            <p className="sc-rail-label">Devices</p>
            <p className="sc-device-row" data-on="false">
              <Laptop className="size-3.5" />
              <span>This MacBook</span>
              <span>this device</span>
            </p>
            <p className="sc-device-row" data-on={chapter === 3 && step >= 4 ? "true" : "false"}>
              <Monitor className="size-3.5" />
              <span>studio-mac</span>
              <span>{workerStatus}</span>
            </p>
          </div>
        </aside>

        <div className="sc-chat">
          <div className="sc-feed">
            <Reveal on={chapter === 0}>
              <div className="sc-repo">
                <p className="sc-repo-name">mezair-stack</p>
                <p className="sc-repo-meta">Local checkout on main. 3 packages.</p>
              </div>
            </Reveal>

            <Reveal on={chapter >= 1}>
              <div className="sc-user">{TASK}</div>
            </Reveal>

            <Reveal on={chapter >= 1}>
              <div className="sc-card" data-state={working ? "working" : "done"}>
                <span className="sc-card-mark">{working ? <span className="sc-live" /> : <Check className="size-3.5" />}</span>
                <span className="sc-card-text">
                  <span className="sc-card-title">
                    {working ? "Working" : "Work completed"}
                    <span className="sc-card-count">{working ? `${rows} action${rows === 1 ? "" : "s"}` : "4 actions"}</span>
                  </span>
                  <span className="sc-card-sub">
                    {working ? `${activity[liveRow].live} ${activity[liveRow].target}` : "Ran pnpm test"}
                  </span>
                </span>
                <span className="sc-card-time">{working ? `${6 + rows * 7}s` : "38s"}</span>
                <ChevronRight className="size-3.5 opacity-60" />
              </div>
            </Reveal>

            <Reveal on={chapter >= 2}>
              <div className="sc-answer">
                <p className="sc-agent">Codex</p>
                <p>
                  Raised <code>MAX_ATTEMPTS</code> to 5 and added a test for the fifth attempt. All 14 tests pass.
                </p>
              </div>
            </Reveal>

            <Reveal on={chapter === 2}>
              <div className="sc-changes">
                <p className="sc-changes-head">
                  2 files changed <span className="sc-add">+9</span> <span className="sc-del">−2</span>
                </p>
                <div className="sc-actions">
                  <span className="sc-btn">
                    <GitCommitHorizontal className="size-3.5" />
                    Commit
                  </span>
                  <span className="sc-btn" data-primary="true">
                    <GitPullRequestArrow className="size-3.5" />
                    Open pull request
                  </span>
                </div>
              </div>
            </Reveal>

            <Reveal on={chapter === 3}>
              <p className="sc-note">
                <Check className="size-3.5 text-[oklch(var(--artifact-ok))]" />
                Committed and pushed fix/retry-limit
              </p>
            </Reveal>
          </div>

          {chapter === 3 ? (
            <div className="sc-chip-row">
              <span>
                <Laptop className="size-3 shrink-0" />
                <span className="sc-trunc">
                  Session on <strong>{sessionOwnerLabel(step)}</strong>
                </span>
              </span>
              {handedOver ? null : <span className="sc-live" />}
            </div>
          ) : null}

          <div className="sc-composer" data-filled={chapter === 0 ? "true" : "false"}>
            <span className="sc-composer-text">{chapter === 0 ? TASK : "Ask a follow-up"}</span>
            <span className="sc-composer-tools">
              <span className="sc-pill">Codex</span>
              <Paperclip className="size-3.5" />
              <span className="sc-send">
                <Send className="size-3" />
              </span>
            </span>
          </div>
        </div>

        <div className="sc-panel">
          <PanelContent chapter={chapter} rows={rows} liveRow={liveRow} step={step} />
        </div>
      </div>
    </div>
  );
}

function PanelContent({ chapter, rows, liveRow, step }: { chapter: number; rows: number; liveRow: number; step: number }) {
  if (chapter === 0) {
    return (
      <>
        <p className="sc-panel-head">
          <FileText className="size-3.5" />
          Context
          <span>mezair-stack</span>
        </p>
        <div className="sc-panel-body" key="task">
          <ul className="sc-tree">
            {files.map((file) => (
              <li key={file.path} data-hot={file.note ? "true" : "false"}>
                <span>{file.path}</span>
                {file.note ? <span>{file.note}</span> : null}
              </li>
            ))}
          </ul>
          <dl className="sc-facts">
            <div>
              <dt>Agent</dt>
              <dd>Codex, your account</dd>
            </div>
            <div>
              <dt>Runs on</dt>
              <dd>This MacBook</dd>
            </div>
            <div>
              <dt>Repo</dt>
              <dd>Your local checkout</dd>
            </div>
          </dl>
        </div>
      </>
    );
  }

  if (chapter === 1) {
    return (
      <>
        <p className="sc-panel-head">
          <Terminal className="size-3.5" />
          Activity
          <span>Codex</span>
        </p>
        <div className="sc-panel-body" key="work">
          <ol className="sc-act">
            {activity.slice(0, rows).map((item, index) => {
              const live = index === liveRow;
              const Icon = item.icon;
              return (
                <li key={`${item.done}-${item.target}-${index}`} data-live={live ? "true" : "false"}>
                  <span className="sc-act-icon">{live ? <span className="sc-live" /> : <Icon className="size-3.5" />}</span>
                  <span className="sc-act-text">
                    {live ? item.live : item.done} <span className="font-mono">{item.target}</span>
                  </span>
                  <span className={`sc-act-result ${item.tone === "del" ? "sc-del" : "sc-add"}`}>{live ? "" : item.result}</span>
                </li>
              );
            })}
          </ol>
          <div className="sc-term">
            {rows < 2 ? <p>No commands yet</p> : null}
            {rows >= 2 ? (
              <p className="is-cmd">
                pnpm test retry
                {rows === 2 ? <span className="sc-cursor" /> : null}
              </p>
            ) : null}
            {rows >= 3 ? <p className="is-fail">FAIL retries 5 times: expected 5, got 3</p> : null}
            {rows >= 4 ? (
              <p className="is-cmd">
                pnpm test
                <span className="sc-cursor" />
              </p>
            ) : null}
          </div>
        </div>
      </>
    );
  }

  if (chapter === 2) {
    return (
      <>
        <p className="sc-panel-head">
          <GitBranch className="size-3.5" />
          Changes
          <span>2 files</span>
        </p>
        <div className="sc-panel-body" key="review">
          <ul className="sc-checks !mt-0">
            <li>
              <Check className="size-3.5 text-[oklch(var(--artifact-ok))]" />
              <span className="font-mono">pnpm test</span>
              <span>14 passed</span>
            </li>
            <li>
              <ShieldCheck className="size-3.5 text-[oklch(var(--artifact-ok))]" />
              <span>Security review</span>
              <span>no findings</span>
            </li>
          </ul>
          <div className="mt-3">
            <div className="sc-diff">
              <p className="sc-diff-head">
                <span>src/retry.ts</span>
                <span>
                  <span className="sc-add">+1</span> <span className="sc-del">−1</span>
                </span>
              </p>
              <pre>
                <span className="is-ctx">{"  import { sleep } from './time';"}</span>
                <span className="is-del">{"- export const MAX_ATTEMPTS = 3;"}</span>
                <span className="is-add">{"+ export const MAX_ATTEMPTS = 5;"}</span>
              </pre>
            </div>
            <div className="sc-diff">
              <p className="sc-diff-head">
                <span>src/retry.test.ts</span>
                <span>
                  <span className="sc-add">+8</span> <span className="sc-del">−1</span>
                </span>
              </p>
              <pre>
                <span className="is-add">{"+ it('retries five times', async () => {"}</span>
                <span className="is-add">{"+   await expect(flaky(5)).resolves.toBe('ok');"}</span>
              </pre>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <p className="sc-panel-head">
        <Laptop className="size-3.5" />
        Session
        <span>Sync &amp; Mesh</span>
      </p>
      <div className="sc-panel-body" key="handoff">
        <HandoffStage step={step} size="compact" />
      </div>
    </>
  );
}

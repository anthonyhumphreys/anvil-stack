"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Check,
  ChevronRight,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequestArrow,
  Laptop,
  Monitor,
  Paperclip,
  Send
} from "lucide-react";
import { cn } from "@/lib/utils";

type Step = {
  title: string;
  body: string;
  note: string;
};

const steps: Step[] = [
  {
    title: "Open a repo.",
    body: "Point Anvil at a checkout on your machine. It reads the structure, branches and recent changes, so the agent starts with context instead of guesses.",
    note: "Anvil runs locally. Your repos stay on your disk."
  },
  {
    title: "Hand it a task.",
    body: "Say what you want in plain words and pick an agent: Codex, Cursor, Devin, OpenAI or Azure OpenAI. Every command and file edit shows up as it happens, and you can stop it at any point.",
    note: "Bring your own accounts. Providers bill you directly."
  },
  {
    title: "Review what changed.",
    body: "The diff, the test run and any security findings sit side by side, so you can judge the work before you commit it.",
    note: "Ask for changes in the same thread."
  },
  {
    title: "Ship it, or pass it on.",
    body: "Commit, open a pull request, or hand the whole session to another of your machines. The notes, checks and open questions travel with it.",
    note: "Handoff needs Sync & Mesh. Anvil hosting is paid; self-hosting is free."
  }
];

const tickerSteps = ["Reading src/retry.ts", "Running pnpm test retry", "Editing src/retry.ts", "Running pnpm test"];

function subscribeReducedMotion(onChange: () => void) {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/**
 * The homepage's one authored moment: Anvil Desktop assembling a real job as
 * you scroll. Large screens pin the window and swap its state per step; small
 * screens show each step's still beneath its text.
 */
export function Workbench() {
  const [active, setActive] = useState(0);
  const [tick, setTick] = useState(0);
  const [visible, setVisible] = useState(false);
  const reduced = useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false
  );
  const sectionRef = useRef<HTMLElement>(null);
  const stepRefs = useRef<Array<HTMLLIElement | null>>([]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = Number((entry.target as HTMLElement).dataset.step);
          if (Number.isFinite(index)) setActive(index);
        }
      },
      { rootMargin: "-45% 0px -45% 0px" }
    );
    for (const element of stepRefs.current) if (element) observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  // The working step's ticker only runs while the section is on screen.
  useEffect(() => {
    if (reduced || !visible || active !== 1) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1500);
    return () => window.clearInterval(timer);
  }, [active, reduced, visible]);

  return (
    <section ref={sectionRef} aria-labelledby="workbench-title" className="relative border-t">
      <h2 id="workbench-title" className="sr-only">
        How Anvil Desktop works
      </h2>
      <div className="page-shell grid gap-x-16 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <ol className="relative">
          {steps.map((step, index) => (
            <li
              key={step.title}
              ref={(element) => {
                stepRefs.current[index] = element;
              }}
              data-step={index}
              className="flex flex-col justify-center py-16 lg:min-h-[78vh] lg:py-0"
            >
              <div className="flex gap-5">
                <span
                  className={cn(
                    "wb-marker mt-2 font-mono text-sm tabular-nums",
                    index <= active ? "text-accent" : "text-muted-foreground"
                  )}
                  aria-hidden="true"
                >
                  {index + 1}
                </span>
                <div
                  className={cn(
                    "transition-opacity duration-500 lg:opacity-35",
                    index === active && "lg:opacity-100"
                  )}
                >
                  <h3 className="font-display text-display-2">{step.title}</h3>
                  <p className="mt-5 max-w-[46ch] text-lg leading-8 text-muted-foreground">{step.body}</p>
                  <p className="mt-4 text-sm font-medium text-foreground">{step.note}</p>
                </div>
              </div>
              <div className="mt-10 lg:hidden" aria-hidden="true">
                <Stage step={index} tick={tick} live={visible && !reduced} />
              </div>
            </li>
          ))}
        </ol>
        <div className="hidden lg:block">
          <div className="sticky top-[max(5.5rem,calc(50vh-19rem))] py-16">
            <div aria-hidden="true">
              <Stage step={active} tick={tick} live={visible && !reduced} />
            </div>
            <p className="mt-4 text-sm text-muted-foreground">
              An illustration of Anvil Desktop. The repo and task are examples.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

/** A still of the workbench at one step, for places that need the picture without the scroll. */
export function WorkbenchStill({ step = 2 }: { step?: number }) {
  return (
    <figure>
      <div aria-hidden="true">
        <Stage step={step} tick={0} live={false} />
      </div>
      <figcaption className="mt-3 text-sm text-muted-foreground">
        An illustration of Anvil Desktop. The repo and task are examples.
      </figcaption>
    </figure>
  );
}

function Stage({ step, tick, live }: { step: number; tick: number; live: boolean }) {
  const working = step === 1;
  const done = step >= 2;
  const ticker = tickerSteps[tick % tickerSteps.length];

  return (
    <div className="wb-window" data-step={step} data-live={live ? "true" : undefined}>
      <div className="wb-titlebar">
        <span className="wb-lights">
          <span />
          <span />
          <span />
        </span>
        <span className="wb-title">anvil-stack</span>
        <span className="wb-branch">
          <GitBranch className="size-3" />
          {step >= 3 ? "fix/retry-limit" : "main"}
        </span>
      </div>

      <div className="wb-body">
        <aside className="wb-rail">
          <p className="wb-rail-label">Threads</p>
          <ul>
            <li className={cn("wb-thread", step >= 1 && "is-current")}>
              <span className={cn("wb-dot", working && "is-working", done && "is-done")} />
              <span>{step >= 1 ? "Retry limit on flaky networks" : "New thread"}</span>
            </li>
            <li className="wb-thread">
              <span className="wb-dot is-done" />
              <span>Login redirect loop</span>
            </li>
            <li className="wb-thread">
              <span className="wb-dot" />
              <span>Docs for the CLI flags</span>
            </li>
          </ul>
          <div className={cn("wb-device", step >= 3 && "is-on")}>
            <p className="wb-rail-label">Devices</p>
            <p className="wb-device-row">
              <Laptop className="size-3.5" />
              This MacBook
            </p>
            <p className="wb-device-row is-target">
              <Monitor className="size-3.5" />
              studio-mac
              <span className="wb-device-status">{step >= 3 ? "ready" : "idle"}</span>
            </p>
          </div>
        </aside>

        <div className="wb-main">
          <div className="wb-feed">
            <Reveal on={step <= 1}>
              <div className="wb-repo">
                <p className="wb-repo-name">anvil-stack</p>
                <p className="wb-repo-meta">412 files indexed. 3 packages. Last commit 2 hours ago.</p>
                <ul className="wb-tree">
                  <li>src/retry.ts</li>
                  <li>src/retry.test.ts</li>
                  <li>src/http/client.ts</li>
                  <li>package.json</li>
                </ul>
              </div>
            </Reveal>

            <Reveal on={step >= 1}>
              <div className="wb-user">
                Retries give up too early on flaky networks. Raise the limit to 5 and add a test that
                proves it.
              </div>
            </Reveal>

            <Reveal on={step >= 1}>
              <div className={cn("wb-card", working && "is-working", done && "is-done")}>
                <span className="wb-card-mark">
                  {done ? <Check className="size-3.5" /> : <span className="wb-live" />}
                </span>
                <span className="wb-card-text">
                  <span className="wb-card-title">
                    {done ? "Work completed" : "Working"}
                    <span className="wb-card-count">{done ? "4 actions" : actionCount(tick)}</span>
                  </span>
                  <span className="wb-card-detail" key={done ? "done" : ticker}>
                    {done ? "Ran pnpm test" : ticker}
                  </span>
                </span>
                <span className="wb-card-time">{done ? "38s" : "12s"}</span>
                <ChevronRight className="size-3.5 opacity-60" />
              </div>
            </Reveal>

            <Reveal on={step >= 2}>
              <div className="wb-answer">
                <p className="wb-agent">Codex</p>
                <p>
                  Raised <code>MAX_ATTEMPTS</code> to 5 and added a test for the fifth attempt. All 14
                  tests pass.
                </p>
              </div>
            </Reveal>

            <Reveal on={step === 2}>
              <div className="wb-diff">
                <p className="wb-diff-head">
                  <span>src/retry.ts</span>
                  <span className="wb-diff-stat">
                    <span className="is-add">+1</span> <span className="is-del">−1</span>
                  </span>
                </p>
                <pre>
                  <span className="is-ctx">{"  import { sleep } from './time';"}</span>
                  <span className="is-del">{"- export const MAX_ATTEMPTS = 3;"}</span>
                  <span className="is-add">{"+ export const MAX_ATTEMPTS = 5;"}</span>
                </pre>
                <p className="wb-checks">
                  <Check className="size-3.5" />
                  pnpm test: 14 passed
                </p>
              </div>
            </Reveal>

            <Reveal on={step >= 3}>
              <div className="wb-changes">
                <p className="wb-changes-head">
                  2 files changed <span className="is-add">+9</span> <span className="is-del">−2</span>
                </p>
                <div className="wb-actions">
                  <span className="wb-btn">
                    <GitCommitHorizontal className="size-3.5" />
                    Commit
                  </span>
                  <span className="wb-btn is-primary">
                    <GitPullRequestArrow className="size-3.5" />
                    Open pull request
                  </span>
                  <span className="wb-btn">
                    <Monitor className="size-3.5" />
                    Continue on studio-mac
                  </span>
                </div>
              </div>
            </Reveal>
          </div>

          <div className="wb-composer">
            <span className="wb-composer-text">
              {step === 0 ? "Ask anything, or type / for commands" : "Ask a follow-up"}
            </span>
            <span className="wb-composer-tools">
              <span className="wb-chip">Codex</span>
              <Paperclip className="size-3.5" />
              <span className="wb-send">
                <Send className="size-3" />
              </span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function actionCount(tick: number) {
  const count = (tick % tickerSteps.length) + 1;
  return `${count} action${count === 1 ? "" : "s"}`;
}

/** Folds a block in and out of the feed without moving what is above it. */
function Reveal({ on, children }: { on: boolean; children: React.ReactNode }) {
  return (
    <div className="wb-reveal" data-on={on ? "true" : "false"}>
      <div className="wb-reveal-inner">{children}</div>
    </div>
  );
}

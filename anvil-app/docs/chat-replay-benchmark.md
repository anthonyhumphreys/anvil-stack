# Chat replay and task benchmark

The replay page is a development-only fixture for checking how Anvil renders chat history and live updates. Every transcript, event, connection transition, composer response, and side thread is synthetic. The page uses the production `ChatInput`, `ChatTranscript`, chat history conversion, turn composition, execution topology, and scroll-position hook, with a local-only IPC bridge. It never opens a provider session or loads workspace data.

Start the local preview from the app directory:

```bash
pnpm exec vite --config scripts/chat-replay.vite.config.ts
```

Open `http://127.0.0.1:4179/`. The Vite config binds only to loopback and serves a separate HTML entry; the Electron renderer build does not include the preview. Choose a scenario, then use **Step** to reveal each recorded event or **Show complete** to load the full scenario. The thread switcher in the recovery scenario lets you test that both history and scroll position stay with their thread. Composer sends are appended to local synthetic history. Voice permission is stubbed as denied; file selection and skill lookup return empty results.

The deterministic scenarios cover partial and complete Markdown, fenced TypeScript and Mermaid, two delegated agents and their status changes, a synthetic transport error and reconnection, thread switching, exact-revision artifact feedback plus file-diff selection, and a 300-turn / 600-message transcript. The parallel-agent scenario also exposes local guide, queue, and read-only side-question controls while the turn is busy. Those callbacks append only synthetic local entries; they do not call a provider.

## Local responsiveness measurements

The side panel uses browser User Timing and React Profiler callbacks. It reports transcript scenario-change-to-commit time, React `actualDuration` for transcript updates, composer input-to-React-commit time, and input-to-next-animation-frame time. It also reports p50/p95 for the most recent 200 samples where there are enough samples. The next-frame measure ends in the browser's next `requestAnimationFrame` callback, before paint; treat it as a frame-latency proxy, not an end-to-end input-to-photon measurement. React durations describe this preview render with synthetic data. **No local performance sample has been recorded in this change.**

For a reproducible local run:

1. Run `node scripts/chat-replay-machine.mjs` and preserve its JSON output with the benchmark notes. It reads the current OS, model where available, CPU model and count, architecture, RAM, and Node version. For this workspace, the current reference machine is Mac15,13 / Apple M3 / 16 GiB RAM. That is system metadata, not a performance result.
2. Use the same browser version, window size, display scaling, power mode, and background workload for every run. Record the browser version and viewport alongside the machine output.
3. Reload the preview, select **Large transcript (300 turns)**, and select **Show complete**. Record the first transcript change-to-commit and React duration as the cold render sample.
4. Select **Reset measurements**, then repeat **Replay** followed by **Show complete** five times. This collects repeatable warm long-transcript updates. Record the displayed p95 transcript React `actualDuration` and p95 scenario commit time.
5. With the complete long transcript loaded, focus the composer and type the same 100-character sample at a steady pace. Do not paste it. Record input-to-React-commit p50/p95 and input-to-next-frame p50/p95. Repeat after a reload for a second cold comparison if needed.
6. Save the exact sample counts with the metrics. The page caps each recent-sample window at 200 values; a p95 from fewer than 20 samples should be marked exploratory.

No result has been recorded in this change. The metrics panel starts empty, and this protocol does not set a pass threshold. Compare runs only when the machine, browser, viewport, transcript scenario, and workload match.

## Task benchmark across tools

For a task benchmark, evaluate **Codex**, **Claude**, **t3code**, and **Anvil** against the same scenario material, prompt, source snapshot, and machine. The five Anvil fixtures are the scenario definitions in [`chat-replay-fixtures.ts`](../src/renderer/components/chat/replay/chat-replay-fixtures.ts). For other tools, provide the same visible transcript/events as text or JSON; do not grant one tool a hidden repository file or extra system prompt. The tasks compare interpretation and interaction outcomes, not provider quality claims or raw rendering speed.

Use one fresh session per scenario and per tool. Keep model and tool version visible in the record. Start the timer when the scenario and task prompt are presented; stop when the tool gives a complete answer. Score against the expected facts only after stopping the timer. Count each missing or incorrect expected fact as one error, and separately note any unsupported claim. Record the context tokens used when the product exposes an exact count; otherwise use `null` and explain why. Ask the operator for confidence from 1 to 5 immediately after each answer, before the scorer shares the result.

Use the following fixed tasks:

| Scenario                        | Task                                                                                                                                                  | Expected facts for scoring                                                                                                                                                                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Streaming rich content          | Inspect the transcript at the partial Markdown, open code fence, and open Mermaid fence steps. State what is complete and what is still arriving.     | The text is partial; the TypeScript fence is open before its closing chunk; Mermaid preview behavior is judged against the last valid source/preview and pending state, without assuming an open fence must always wait to render; do not invent missing output. |
| Parallel agents and status      | At the spawn step, report how many agents are running and their latest visible states. Repeat after the completion events.                            | Two agents are running after spawn; each is completed in the final topology; the main turn status becomes complete.                                                                                                                                              |
| Error, reconnect, thread switch | Switch to the unrelated thread while the first is reconnecting, then return after reconnection. Report each thread's transcript and connection state. | The first thread owns the error and recovery; the unrelated thread retains its own two messages; the first thread reconnects; switching does not mix history.                                                                                                    |
| Artifact and diff feedback      | Select text from artifact revision 2 and review both changed files. Hand off feedback referencing the selected revision and passage.                  | Feedback names artifact v2, carries the exact selected quote and line range, and returns to the originating thread; diff review selects the requested file and preserves review position.                                                                        |
| Large transcript                | Read the final turn and state its number and answer.                                                                                                  | The fixture has 300 turns / 600 messages; the final turn is Turn 300; report only its synthetic assistant conclusion.                                                                                                                                            |

Keep completion time, error count, context tokens, confidence, software version, and notes separate for each tool and scenario. The starter record at [`chat-replay-benchmark.template.json`](chat-replay-benchmark.template.json) leaves every result unmeasured. Do not enter estimates for a product that has not been run; leave its status as `unmeasured`. Cross-tool trials, browser captures, and live-provider checks are pending; this change makes no comparative or provider-delivery claim.

"use client";

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import {
  KeyRound,
  Laptop,
  LockKeyhole,
  LockKeyholeOpen,
  Monitor,
  Pause,
  Play,
  Server,
  ShieldCheck,
  X
} from "lucide-react";
import { handoffSteps } from "./handoff-stage";
import { useTimeline, type TimelineChapter } from "./use-timeline";

/* ----------------------------------------------------------------------------
 * Geometry
 * ------------------------------------------------------------------------- */

type Pt = { x: number; y: number };
type NodeId = "laptop" | "studio" | "build" | "backend";
type RouteId = "lan" | "private" | "https" | "managed";
type Curve = { a: Pt; c: Pt; b: Pt };

type Layout = {
  name: "wide" | "tall";
  w: number;
  h: number;
  nodeH: number;
  nodes: Record<NodeId, Pt & { w: number }>;
  doc: Pt;
  termLaptop: Pt & { w: number };
  termStudio: Pt & { w: number };
  bends: Record<RouteId, number>;
};

const WIDE: Layout = {
  name: "wide",
  w: 1000,
  h: 476,
  nodeH: 74,
  nodes: {
    backend: { x: 500, y: 58, w: 316 },
    laptop: { x: 168, y: 246, w: 248 },
    studio: { x: 832, y: 246, w: 248 },
    build: { x: 500, y: 418, w: 248 }
  },
  doc: { x: 168, y: 112 },
  termLaptop: { x: 168, y: 376, w: 296 },
  termStudio: { x: 832, y: 376, w: 296 },
  bends: { lan: 0, private: 0.17, https: 0.34, managed: -0.26 }
};

const TALL: Layout = {
  name: "tall",
  w: 400,
  h: 720,
  nodeH: 70,
  nodes: {
    backend: { x: 200, y: 50, w: 300 },
    laptop: { x: 112, y: 232, w: 204 },
    studio: { x: 288, y: 462, w: 204 },
    build: { x: 112, y: 662, w: 204 }
  },
  doc: { x: 300, y: 150 },
  termLaptop: { x: 128, y: 352, w: 236 },
  termStudio: { x: 250, y: 572, w: 280 },
  bends: { lan: 0, private: 0.34, https: 0.7, managed: -0.46 }
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
/** Progress of `t` through [from, to]. */
const span = (t: number, from: number, to: number) => clamp01((t - from) / (to - from));
const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const between = (t: number, from: number, to: number) => t >= from && t < to;

function curve(a: Pt, b: Pt, bend = 0): Curve {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // Perpendicular offset proportional to length; positive bends down/right.
  return { a, b, c: { x: mx - dy * bend, y: my + dx * bend } };
}

function along({ a, c, b }: Curve, p: number): Pt {
  const q = 1 - p;
  return { x: q * q * a.x + 2 * q * p * c.x + p * p * b.x, y: q * q * a.y + 2 * q * p * c.y + p * p * b.y };
}

const pathD = ({ a, c, b }: Curve) => `M${a.x} ${a.y} Q${c.x} ${c.y} ${b.x} ${b.y}`;

/* ----------------------------------------------------------------------------
 * Chapters
 * ------------------------------------------------------------------------- */

type Beat = { at: number; title: string; body: string; code?: string };

const SYNC_BEATS: Beat[] = [
  { at: 0, title: "Saved locally", body: "Mezair saves the edit on this MacBook first, even when it is offline." },
  { at: 1.6, title: "Encrypted on the device", body: "The MacBook encrypts the change with AES-256-GCM and your account key. Without the key, the change stays queued." },
  { at: 3.4, title: "Stored as ciphertext", body: "The backend can read ids, sizes and timestamps. It cannot read the contents." },
  { at: 5.2, title: "Pulled by your devices", body: "Each enrolled device downloads the same encrypted change." },
  { at: 7.4, title: "Decrypted and applied", body: "Each device decrypts the change with its copy of the key and applies revision 42." }
];

const MESH_BEATS: Beat[] = [
  { at: 0, title: "Create the job", body: "The MacBook asks studio-mac to start a session at commit 3f9c2e1." },
  { at: 1.6, title: "Recorded by the backend", body: "Your backend stores the job record. It does not run the job." },
  { at: 3.2, title: "Claimed by the worker", body: "studio-mac claims the job and takes a lease, which records which machine is running it." },
  { at: 4.8, title: "Checked out at the commit", body: "The worker checks out 3f9c2e1 in its own worktree and verifies the Git state before it starts." },
  { at: 6.4, title: "Output streamed back", body: "The MacBook shows the output as the agent runs. The worker's logins stay on the worker." },
  { at: 10.4, title: "Final state", body: "The job ends as completed, failed or lost contact. Mezair reports lost contact instead of guessing an outcome." }
];

const ROUTE_BEATS: Beat[] = [
  { at: 0, title: "LAN first", body: "Mesh tries the host's LAN address before any other route." },
  { at: 2.2, title: "Direct connection", body: "While both machines are on the same network, commands and output use the LAN route." },
  { at: 5, title: "LAN route lost", body: "You leave the network and the LAN route stops answering. Requests already sent finish on their original connection." },
  { at: 6.4, title: "Fallback", body: "Mesh tries other private routes, then HTTPS, then managed ingress. Here HTTPS answers first." },
  { at: 9, title: "LAN route back", body: "The new LAN connection has to authenticate and catch up before Mesh switches to it." },
  { at: 11, title: "Switched back", body: "Mesh switches without resending any command. Your backend still authorises every session." }
];

const HANDOFF_AT = [0, 1.5, 3, 4.5, 6.2, 8, 9.6];
const HANDOFF_BODY = [
  "You press Move session on this MacBook.",
  "studio-mac checks out the pinned commits but does not start the agent.",
  "The MacBook pauses the running turn.",
  "The MacBook saves a checkpoint and encrypts it with your account key.",
  "Ownership moves to studio-mac at generation 5. The MacBook can no longer send commands.",
  "studio-mac decrypts the checkpoint before it calls the provider.",
  "The session continues on studio-mac."
];
const HANDOFF_BEATS: Beat[] = handoffSteps.map((step, index) => ({
  at: HANDOFF_AT[index],
  title: step.label,
  body: HANDOFF_BODY[index],
  code: step.state
}));

const chapters = [
  {
    id: "sync",
    label: "Sync",
    hint: "Encrypted on the device",
    duration: 11,
    keyTime: 6.3,
    beats: SYNC_BEATS,
    summary:
      "Sync: Dana's MacBook saves an edit to the Acme workspace and encrypts it with AES-256-GCM and the account key. The Sync backend stores the ciphertext and can read only metadata. studio-mac and build-box download the change and decrypt it."
  },
  {
    id: "mesh",
    label: "Mesh job",
    hint: "Run it on another machine",
    duration: 12,
    keyTime: 8.4,
    beats: MESH_BEATS,
    summary:
      "Mesh job: the MacBook asks studio-mac to start a session at commit 3f9c2e1. The backend records the job. studio-mac claims it, checks out the commit in its own worktree and runs the agent with its own logins. The output streams back to the MacBook until the job completes."
  },
  {
    id: "routes",
    label: "LAN-first routes",
    hint: "Tries the LAN first",
    duration: 13,
    keyTime: 10,
    beats: ROUTE_BEATS,
    summary:
      "LAN-first routes: Mesh tries the host's LAN address first and runs the live session over it. When the LAN route stops answering, Mesh falls back to the next route that answers, here HTTPS. When the LAN route returns, it authenticates and catches up before the session switches back. Mesh never resends a command."
  },
  {
    id: "handoff",
    label: "Handoff",
    hint: "Move a running session",
    duration: 12,
    keyTime: 7,
    beats: HANDOFF_BEATS,
    summary:
      "Handoff: a running session moves from the MacBook to studio-mac through the app's seven handoff states. The MacBook encrypts a checkpoint, the backend carries it, and ownership moves from generation 4 to 5 before studio-mac resumes the session."
  }
] as const satisfies ReadonlyArray<TimelineChapter & { id: string; label: string; hint: string; beats: Beat[]; summary: string }>;

const timelineChapters: TimelineChapter[] = chapters.map(({ duration, keyTime }) => ({ duration, keyTime }));

function beatAt(beats: Beat[], t: number) {
  let index = 0;
  for (let i = 0; i < beats.length; i += 1) if (t >= beats[i].at) index = i;
  return index;
}

/* ----------------------------------------------------------------------------
 * SVG primitives
 * ------------------------------------------------------------------------- */

type Tone = "dim" | "text" | "live" | "ok" | "warn" | "del";

const icons = { laptop: Laptop, studio: Monitor, build: Server, backend: ShieldCheck } as const;
const titles: Record<NodeId, string> = {
  laptop: "Dana’s MacBook Pro",
  studio: "studio-mac",
  build: "build-box",
  backend: "Your Sync backend"
};

type NodeState = { status: string; tone?: Tone; active?: boolean; dim?: boolean };

function NodeBox({ id, layout, state }: { id: NodeId; layout: Layout; state: NodeState }) {
  const n = layout.nodes[id];
  const h = layout.nodeH;
  const x = n.x - n.w / 2;
  const y = n.y - h / 2;
  const Icon = icons[id];
  const tall = layout.name === "tall";
  return (
    <g className="ms-node" data-active={state.active ? "true" : "false"} data-dim={state.dim ? "true" : "false"}>
      <rect x={x} y={y} width={n.w} height={h} rx={14} className="ms-node-box" />
      <Icon x={x + 16} y={y + (tall ? 15 : 17)} width={tall ? 18 : 20} height={tall ? 18 : 20} className="ms-node-icon" />
      <text x={x + (tall ? 42 : 46)} y={y + (tall ? 29 : 32)} className="ms-node-title">
        {titles[id]}
      </text>
      <text x={x + (tall ? 42 : 46)} y={y + (tall ? 52 : 56)} className="ms-node-status" data-tone={state.tone ?? "dim"}>
        {state.status}
      </text>
    </g>
  );
}

function Packet({ at, label, tone = "live", icon }: { at: Pt; label: string; tone?: Tone; icon?: "lock" | "open" | "key" }) {
  const w = label.length * 7.4 + (icon ? 36 : 20);
  const h = 26;
  const Icon = icon === "open" ? LockKeyholeOpen : icon === "key" ? KeyRound : LockKeyhole;
  return (
    <g className="ms-packet" data-tone={tone} transform={`translate(${at.x - w / 2} ${at.y - h / 2})`}>
      <rect width={w} height={h} rx={8} className="ms-packet-box" />
      {icon ? <Icon x={10} y={6} width={14} height={14} className="ms-packet-icon" /> : null}
      <text x={icon ? 28 : 10} y={17.5} className="ms-packet-text">
        {label}
      </text>
    </g>
  );
}

function Flow({ c, t, reverse = false, count = 5, speed = 0.55, tone = "live" }: { c: Curve; t: number; reverse?: boolean; count?: number; speed?: number; tone?: Tone }) {
  return (
    <g className="ms-flow" data-tone={tone}>
      {Array.from({ length: count }, (_, index) => {
        const p = (t * speed + index / count) % 1;
        const point = along(c, reverse ? 1 - p : p);
        const fade = Math.sin(p * Math.PI);
        return <circle key={index} cx={point.x} cy={point.y} r={3.2} opacity={fade} />;
      })}
    </g>
  );
}

type Line = { at: number; text: string; tone?: Tone };

function Terminal({ box, lines, t, from, title }: { box: Pt & { w: number }; lines: Line[]; t: number; from: number; title: string }) {
  if (t < from) return null;
  const shown = lines.filter((line) => t >= line.at).slice(-4);
  const h = 128;
  const x = box.x - box.w / 2;
  const y = box.y - h / 2;
  return (
    <g className="ms-term" style={{ opacity: span(t, from, from + 0.4) }}>
      <rect x={x} y={y} width={box.w} height={h} rx={10} className="ms-term-box" />
      <text x={x + 14} y={y + 22} className="ms-term-title">
        {title}
      </text>
      {shown.map((line, index) => (
        <text key={`${line.at}-${line.text}`} x={x + 14} y={y + 50 + index * 21} className="ms-term-line" data-tone={line.tone ?? "text"}>
          {line.text}
        </text>
      ))}
    </g>
  );
}

const CIPHER = "x9Fq2Lk7Zr0Vb4Np8Wc1Hs6Mt3Gd5Ja";

function scramble(text: string, amount: number, seed: number) {
  const cut = Math.floor(text.length * amount);
  return [...text]
    .map((char, index) => (char === " " || index >= cut ? char : CIPHER[(index * 7 + seed) % CIPHER.length]))
    .join("");
}

function DocCard({ at, t, sealed }: { at: Pt; t: number; sealed: number }) {
  const lines = ['{ "workspace": "Acme",', '  "repos": ["storefront"],', '  "agents": 3, "rev": 42 }'];
  const w = 238;
  const h = 96;
  const x = at.x - w / 2;
  const y = at.y - h / 2;
  return (
    <g className="ms-doc" data-sealed={sealed > 0.6 ? "true" : "false"}>
      <rect x={x} y={y} width={w} height={h} rx={10} className="ms-doc-box" />
      {sealed > 0.6 ? <LockKeyhole x={x + w - 26} y={y + 10} width={14} height={14} className="ms-doc-lock" /> : null}
      <text x={x + 12} y={y + 22} className="ms-doc-head">
        {sealed > 0.6 ? "encrypted · AES-256-GCM · key v3" : "workspace · Acme"}
      </text>
      {lines.map((line, index) => (
        <text key={index} x={x + 12} y={y + 46 + index * 18} className="ms-doc-line">
          {scramble(line, sealed, index * 5 + Math.floor(t * 12))}
        </text>
      ))}
    </g>
  );
}

function Tag({ at, text, tone = "dim", anchor = "middle" }: { at: Pt; text: string; tone?: Tone; anchor?: "start" | "middle" | "end" }) {
  return (
    <text x={at.x} y={at.y} textAnchor={anchor} className="ms-tag" data-tone={tone}>
      {text}
    </text>
  );
}

/* ----------------------------------------------------------------------------
 * Scenes
 * ------------------------------------------------------------------------- */

type Scene = { nodes: Record<NodeId, NodeState>; under: ReactNode; over: ReactNode };

function account(layout: Layout, from: NodeId, to: NodeId) {
  return curve(layout.nodes[from], layout.nodes[to], 0);
}

function syncScene(layout: Layout, t: number): Scene {
  const up = account(layout, "laptop", "backend");
  const toStudio = account(layout, "backend", "studio");
  const toBuild = account(layout, "backend", "build");
  const sealed = span(t, 1.7, 3.1);
  const push = easeInOut(span(t, 3.4, 5));
  const fan = easeInOut(span(t, 5.2, 7.2));
  const opened = t >= 7.4;
  return {
    nodes: {
      laptop: {
        status: t < 1.6 ? "edited workspace Acme" : t < 3.4 ? "sealing…" : "pushed rev 42",
        tone: t < 3.4 ? "live" : "ok",
        active: t < 3.4
      },
      backend: {
        status: t < 5 ? "carries ciphertext only" : "workspace · rev 42 · 1.8 KB",
        tone: t < 5 ? "dim" : "live",
        active: between(t, 5, 7.4)
      },
      studio: { status: opened ? "opened rev 42" : "trusted · rev 41", tone: opened ? "ok" : "dim", active: opened },
      build: { status: opened ? "opened rev 42" : "trusted · rev 41", tone: opened ? "ok" : "dim", active: opened }
    },
    under: (
      <>
        <path d={pathD(up)} className="ms-edge" data-hot={between(t, 3.4, 5.2) ? "true" : "false"} />
        <path d={pathD(toStudio)} className="ms-edge" data-hot={between(t, 5.2, 7.4) ? "true" : "false"} />
        <path d={pathD(toBuild)} className="ms-edge" data-hot={between(t, 5.2, 7.4) ? "true" : "false"} />
        {between(t, 3.4, 5.15) ? <Packet at={along(up, push)} label="encrypted · 1.8 KB" icon="lock" /> : null}
        {between(t, 5.2, 7.35) ? (
          <>
            <Packet at={along(toStudio, fan)} label="rev 42" icon="lock" />
            <Packet at={along(toBuild, fan)} label="rev 42" icon="lock" />
          </>
        ) : null}
      </>
    ),
    over: (
      <>
        {t < 3.6 ? (
          <g style={{ opacity: span(t, 0, 0.4) * (1 - span(t, 3.3, 3.6)) }}>
            <DocCard at={layout.doc} t={t} sealed={sealed} />
          </g>
        ) : null}
        {t >= 7.4 ? (
          <>
            <Packet at={{ x: layout.nodes.studio.x, y: layout.nodes.studio.y - layout.nodeH / 2 - 20 }} label="decrypted" tone="ok" icon="open" />
            <Packet at={{ x: layout.nodes.build.x, y: layout.nodes.build.y - layout.nodeH / 2 - 20 }} label="decrypted" tone="ok" icon="open" />
          </>
        ) : null}
      </>
    )
  };
}

const STUDIO_LINES: Line[] = [
  { at: 4.9, text: "$ git checkout 3f9c2e1", tone: "text" },
  { at: 5.5, text: "worktree clean · commit verified", tone: "ok" },
  { at: 6.1, text: "$ pnpm install --frozen-lockfile", tone: "text" },
  { at: 6.7, text: "codex · gpt-5.6-sol · ask first", tone: "dim" }
];

const LAPTOP_LINES: Line[] = [
  { at: 6.9, text: "read src/lib/retry.ts", tone: "dim" },
  { at: 7.5, text: "$ pnpm test -- retry", tone: "text" },
  { at: 8.1, text: "FAIL expected 5, received 3", tone: "del" },
  { at: 8.7, text: "edit src/lib/retry.ts  +1 −1", tone: "dim" },
  { at: 9.3, text: "$ pnpm test", tone: "text" },
  { at: 9.9, text: "✓ 14 passed", tone: "ok" }
];

function meshScene(layout: Layout, t: number): Scene {
  const up = account(layout, "laptop", "backend");
  const down = account(layout, "backend", "studio");
  const direct = curve(layout.nodes.laptop, layout.nodes.studio, 0);
  const job = easeInOut(span(t, 1, 2.6));
  const claim = easeInOut(span(t, 3.2, 4.6));
  const done = t >= 10.4;
  const studio = layout.nodes.studio;
  return {
    nodes: {
      laptop: {
        status: t < 1 ? "new job for studio-mac" : done ? "result received" : t >= 6.4 ? "watching live" : "job sent",
        tone: done ? "ok" : "live",
        active: t < 1.6 || between(t, 6.4, 10.4)
      },
      backend: {
        status: t < 2.6 ? "coordinates, never runs" : done ? "job completed" : "job queued → studio-mac",
        tone: t < 2.6 ? "dim" : done ? "ok" : "live",
        active: between(t, 2.6, 4.8)
      },
      studio: {
        status: t < 4.6 ? "worker · idle" : done ? "completed" : t < 6.4 ? "claimed · fence 1" : "running in its worktree",
        tone: t < 4.6 ? "dim" : done ? "ok" : "live",
        active: t >= 4.6
      },
      build: { status: "worker · idle", dim: true }
    },
    under: (
      <>
        <path d={pathD(up)} className="ms-edge" data-hot={between(t, 1, 2.6) ? "true" : "false"} />
        <path d={pathD(down)} className="ms-edge" data-hot={between(t, 3.2, 4.6) ? "true" : "false"} />
        <path d={pathD(account(layout, "backend", "build"))} className="ms-edge" data-dim="true" />
        <path d={pathD(direct)} className="ms-edge ms-edge-route" data-hot={between(t, 6.4, 10.4) ? "true" : "false"} />
        {between(t, 0.3, 2.6) ? (
          <Packet at={t < 1 ? along(up, 0) : along(up, job)} label="job · 3f9c2e1" />
        ) : null}
        {between(t, 3.2, 4.6) ? <Packet at={along(down, claim)} label="claim · lease 5m" tone="text" /> : null}
        {between(t, 6.4, 10.4) ? <Flow c={direct} t={t} reverse count={7} speed={0.45} /> : null}
      </>
    ),
    over: (
      <>
        <Terminal box={layout.termStudio} lines={STUDIO_LINES} t={t} from={4.8} title="studio-mac · attempt att_5a0e" />
        <Terminal box={layout.termLaptop} lines={LAPTOP_LINES} t={t} from={6.6} title="Watch · live from studio-mac" />
        {t >= 6.4 ? (
          <Packet
            at={{ x: studio.x, y: studio.y - layout.nodeH / 2 - 20 }}
            label="Codex login stays here"
            tone="dim"
            icon="key"
          />
        ) : null}
      </>
    )
  };
}

type RouteState = "idle" | "probe" | "live" | "down" | "fail" | "auth" | "standby";

function routeStates(t: number): Record<RouteId, RouteState> {
  const lan: RouteState = t < 1 ? "probe" : t < 5 ? "live" : t < 9 ? "down" : t < 11 ? "auth" : "live";
  const priv: RouteState = t < 6.4 ? "idle" : t < 7.1 ? "probe" : "fail";
  const https: RouteState = t < 7.1 ? "idle" : t < 7.7 ? "probe" : t < 11 ? "live" : "standby";
  return { lan, private: priv, https, managed: "idle" };
}

const routeLabels: Record<RouteId, string> = {
  lan: "LAN address",
  private: "Private network",
  https: "HTTPS",
  managed: "Managed ingress · provider proxy"
};

const routeNotes: Record<RouteState, string> = {
  idle: "",
  probe: "trying…",
  live: "live",
  down: "unreachable",
  fail: "no answer",
  auth: "authenticating · catching up",
  standby: "standby"
};

function routesScene(layout: Layout, t: number): Scene {
  const { laptop, studio } = layout.nodes;
  const states = routeStates(t);
  const live = (Object.keys(states) as RouteId[]).find((id) => states[id] === "live");
  const order: RouteId[] = ["managed", "lan", "private", "https"];
  return {
    nodes: {
      laptop: {
        status: live === "lan" ? "session live · Direct" : live === "https" ? "session live · HTTPS" : "connecting…",
        tone: live ? "live" : "warn",
        active: true
      },
      studio: { status: "host · listening", tone: "ok", active: true },
      backend: { status: "admits every session", tone: "dim" },
      build: { status: "", dim: true }
    },
    under: (
      <>
        <path d={pathD(account(layout, "laptop", "backend"))} className="ms-edge" data-thin="true" />
        <path d={pathD(account(layout, "backend", "studio"))} className="ms-edge" data-thin="true" />
        {order.map((id) => {
          const c = curve(laptop, studio, layout.bends[id]);
          const state = states[id];
          const mid = along(c, 0.5);
          const labelY =
            layout.name === "tall"
              ? mid.y + (id === "lan" ? -8 : 4)
              : mid.y + (layout.bends[id] < 0 ? -12 : id === "lan" ? -14 : 24);
          return (
            <g key={id} className="ms-route" data-state={state}>
              <path d={pathD(c)} className="ms-route-path" />
              {state === "live" ? (
                <>
                  <Flow c={c} t={t} count={5} speed={0.5} />
                  <Flow c={c} t={t + 0.33} reverse count={4} speed={0.42} tone="text" />
                </>
              ) : null}
              {state === "probe" ? <circle className="ms-probe" cx={along(c, span(t % 0.7, 0, 0.7)).x} cy={along(c, span(t % 0.7, 0, 0.7)).y} r={5} /> : null}
              <text x={mid.x} y={labelY} textAnchor="middle" className="ms-route-label">
                {routeLabels[id]}
                {routeNotes[state] ? <tspan className="ms-route-note"> · {routeNotes[state]}</tspan> : null}
              </text>
              {state === "down" || state === "fail" ? (
                <X x={mid.x - 9} y={mid.y - 9} width={18} height={18} className="ms-route-x" />
              ) : null}
              {state === "auth" ? (
                <circle
                  cx={mid.x}
                  cy={mid.y}
                  r={11}
                  className="ms-route-ring"
                  pathLength={1}
                  style={{ strokeDashoffset: 1 - span(t, 9, 10.9) } as CSSProperties}
                />
              ) : null}
            </g>
          );
        })}
      </>
    ),
    over:
      t >= 11 ? (
        <Tag
          at={{ x: laptop.x, y: laptop.y + layout.nodeH / 2 + 26 }}
          text="0 commands resent"
          tone="ok"
        />
      ) : t >= 5 && t < 9 ? (
        <Tag at={{ x: laptop.x, y: laptop.y + layout.nodeH / 2 + 26 }} text="away from home network" tone="warn" />
      ) : null
  };
}

function handoffScene(layout: Layout, t: number): Scene {
  const step = beatAt(HANDOFF_BEATS, t);
  const up = account(layout, "laptop", "backend");
  const down = account(layout, "backend", "studio");
  const carryUp = easeInOut(span(t, 4.8, 6));
  const carryDown = easeInOut(span(t, 6.2, 7.7));
  const sourceStatus = ["owns session · gen 4", "owns session · gen 4", "pausing the turn", "checkpointed", "relinquished", "relinquished", "relinquished"][step];
  const targetStatus = ["trusted · idle", "prepared · not running", "prepared · not running", "prepared · not running", "owns session · gen 5", "opening checkpoint", "running the session"][step];
  const { laptop, studio } = layout.nodes;
  const pillOffset = layout.nodeH / 2 + 20;
  return {
    nodes: {
      laptop: { status: sourceStatus, tone: step <= 1 ? "live" : step <= 3 ? "warn" : "dim", active: step <= 3 },
      studio: { status: targetStatus, tone: step >= 6 ? "ok" : step >= 4 ? "live" : "dim", active: step >= 1 },
      backend: { status: `handoff · ${handoffSteps[step].state.split("-")[0]}`, tone: "live", active: between(t, 4.8, 7.7) },
      build: { status: "", dim: true }
    },
    under: (
      <>
        <path d={pathD(up)} className="ms-edge" data-hot={between(t, 4.8, 6) ? "true" : "false"} />
        <path d={pathD(down)} className="ms-edge" data-hot={between(t, 6.2, 7.7) ? "true" : "false"} />
        {between(t, 4.6, 6.1) ? <Packet at={t < 4.8 ? along(up, 0) : along(up, carryUp)} label="checkpoint · encrypted" icon="lock" /> : null}
        {between(t, 6.1, 7.75) ? <Packet at={along(down, carryDown)} label="checkpoint · encrypted" icon="lock" /> : null}
      </>
    ),
    over:
      step < 4 ? (
        <Packet at={{ x: laptop.x, y: laptop.y - pillOffset }} label="session · gen 4" tone={step === 2 ? "warn" : "live"} />
      ) : (
        <Packet at={{ x: studio.x, y: studio.y - pillOffset }} label="session · gen 5" tone={step >= 6 ? "ok" : "live"} />
      )
  };
}

const scenes = [syncScene, meshScene, routesScene, handoffScene];

/* ----------------------------------------------------------------------------
 * Stage
 * ------------------------------------------------------------------------- */

function useLayout(ref: React.RefObject<HTMLElement | null>) {
  const [layout, setLayout] = useState<Layout>(WIDE);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setLayout(entry.contentRect.width < 620 ? TALL : WIDE));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return layout;
}

/**
 * How Sync & Mesh actually behave, as one stage with four stories: sealed
 * sync, a Mesh job, LAN-first route switching and a session handoff. The
 * devices, commits and states are fixture content; the behaviour, state names
 * and ordering follow the shipped protocol (cloud/contract).
 */
export function MeshStage({ compact = false }: { compact?: boolean }) {
  const { rootRef, chapter, time, progress, animating, reduced, playing, select, toggle } = useTimeline(timelineChapters);
  const boxRef = useRef<HTMLDivElement>(null);
  const layout = useLayout(boxRef);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const current = chapters[chapter];
  const scene = scenes[chapter](layout, time);
  const beat = beatAt(current.beats as Beat[], time);
  const beats = current.beats as Beat[];

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
    <div ref={rootRef} className="ms" data-compact={compact ? "true" : "false"} data-motion={animating ? "on" : "off"}>
      <div role="tablist" aria-label="How Sync and Mesh work" className="reel-tabs ms-tabs" onKeyDown={onKeyDown}>
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
              id={`ms-tab-${item.id}`}
              aria-selected={selected}
              aria-controls="ms-panel"
              tabIndex={selected ? 0 : -1}
              className="reel-tab"
              onClick={() => select(index)}
            >
              <span className="reel-bar" style={{ "--p": selected && (animating || !reduced) ? progress : 0 } as CSSProperties} aria-hidden="true" />
              <span className="reel-tab-label">{item.label}</span>
              <span className="reel-tab-hint">{item.hint}</span>
            </button>
          );
        })}
      </div>

      <div role="tabpanel" id="ms-panel" aria-labelledby={`ms-tab-${current.id}`} tabIndex={0} className="ms-panel">
        <p className="sr-only">{current.summary}</p>
        <div ref={boxRef} className="ms-stage" aria-hidden="true">
          <svg viewBox={`0 0 ${layout.w} ${layout.h}`} className="ms-svg" data-layout={layout.name}>
            <defs>
              <radialGradient id="ms-floor" cx="50%" cy="45%" r="60%">
                <stop offset="0" stopColor="oklch(0.3 0.07 262)" stopOpacity="0.55" />
                <stop offset="1" stopColor="oklch(0.3 0.07 262)" stopOpacity="0" />
              </radialGradient>
            </defs>
            <rect width={layout.w} height={layout.h} fill="url(#ms-floor)" />
            <g key={`${current.id}-under`}>{scene.under}</g>
            {(Object.keys(scene.nodes) as NodeId[]).map((id) => (
              <NodeBox key={id} id={id} layout={layout} state={scene.nodes[id]} />
            ))}
            <g key={`${current.id}-over`}>{scene.over}</g>
          </svg>
        </div>

        <div className="ms-caption">
          <p className="ms-now" aria-hidden="true">
            <span className="ms-now-title">{beats[beat].title}.</span> {beats[beat].body}
          </p>
          <ol className="ms-beats" aria-label={`${current.label} steps`}>
            {beats.map((item, index) => (
              <li key={item.title} data-phase={index < beat ? "done" : index === beat ? "now" : "next"} aria-current={index === beat ? "step" : undefined}>
                <span>{item.title}</span>
                {item.code ? <code>{item.code}</code> : null}
              </li>
            ))}
          </ol>
        </div>
      </div>

      <div className="ms-foot">
        <p className="cine-fine">
          The devices and commits are examples. The states and their order match the app&apos;s protocol.
        </p>
        {reduced ? null : (
          <button type="button" className="reel-toggle" onClick={toggle} aria-label={playing ? "Pause the animation" : "Play the animation"}>
            {playing ? <Pause className="size-4" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
          </button>
        )}
      </div>
    </div>
  );
}

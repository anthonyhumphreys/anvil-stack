"use client";

import { useEffect, useRef } from "react";

const ROUTES = {
  // macbook -> relay -> workstation (sync push + pull)
  laptopToWorkstation: "M 168 108 Q 240 148 320 208 Q 402 146 472 104",
  // workstation -> relay (artifact upload)
  workstationToRelay: "M 472 104 Q 402 146 320 208",
  // relay -> workstation (job dispatch)
  relayToWorkstation: "M 320 208 Q 402 146 472 104",
  // phone -> relay -> macbook (companion pull)
  phoneToLaptop: "M 502 318 Q 420 268 320 208 Q 240 148 168 108",
  // handoff arc laptop -> workstation (checkpoint)
  handoff: "M 168 66 Q 320 26 472 66"
} as const;

function EnvelopePacket({ path, dur, begin }: { path: string; dur: string; begin: string }) {
  return (
    <g aria-hidden="true">
      <animateMotion dur={dur} begin={begin} repeatCount="indefinite" path={path} />
      <rect x="-7" y="-5" width="14" height="10" rx="2.5" className="schematic-packet" />
      <path d="M -5.5 -2.5 L 0 2 L 5.5 -2.5" className="schematic-packet-flap" />
    </g>
  );
}

function JobPacket({ path, dur, begin }: { path: string; dur: string; begin: string }) {
  return (
    <g aria-hidden="true">
      <animateMotion dur={dur} begin={begin} repeatCount="indefinite" path={path} />
      <rect x="-4.5" y="-4.5" width="9" height="9" transform="rotate(45)" className="schematic-packet-job" />
    </g>
  );
}

function CheckpointPacket({ path, dur, begin }: { path: string; dur: string; begin: string }) {
  return (
    <g aria-hidden="true">
      <animateMotion dur={dur} begin={begin} repeatCount="indefinite" path={path} />
      <rect x="-4" y="-4" width="8" height="8" rx="1.5" className="schematic-packet-checkpoint" />
    </g>
  );
}

function DeviceGlyph({ x, y, kind }: { x: number; y: number; kind: "laptop" | "tower" | "phone" }) {
  if (kind === "laptop") {
    return (
      <g transform={`translate(${x} ${y})`}>
        <rect x="0" y="0" width="56" height="36" rx="5" className="schematic-node" />
        <rect x="6" y="6" width="44" height="22" rx="2" className="schematic-screen" />
        <path d="M -8 42 L 64 42 L 58 48 L -2 48 Z" className="schematic-node" />
      </g>
    );
  }
  if (kind === "tower") {
    return (
      <g transform={`translate(${x} ${y})`}>
        <rect x="0" y="0" width="40" height="56" rx="5" className="schematic-node" />
        <circle cx="20" cy="14" r="5" className="schematic-screen" />
        <rect x="10" y="28" width="20" height="3" rx="1.5" className="schematic-screen" />
        <rect x="10" y="36" width="20" height="3" rx="1.5" className="schematic-screen" />
      </g>
    );
  }
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x="0" y="0" width="30" height="52" rx="6" className="schematic-node" />
      <rect x="4" y="8" width="22" height="34" rx="2" className="schematic-screen" />
      <circle cx="15" cy="47" r="2" className="schematic-screen" />
    </g>
  );
}

export function MeshSchematic({ className }: { className?: string }) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      if (media.matches || document.hidden) svg.pauseAnimations();
      else svg.unpauseAnimations();
    };
    apply();
    media.addEventListener("change", apply);
    document.addEventListener("visibilitychange", apply);
    return () => {
      media.removeEventListener("change", apply);
      document.removeEventListener("visibilitychange", apply);
    };
  }, []);

  return (
    <figure className={className} aria-labelledby="mesh-schematic-title" role="group">
      <figcaption id="mesh-schematic-title" className="sr-only">
        Diagram of Anvil sync topology: three devices exchange sealed envelopes through a backend relay
        that sees the shape of traffic but never the content. Jobs dispatch to a workstation worker;
        a checkpoint crosses between laptop and workstation during session handoff.
      </figcaption>
      <div className="forge-panel forge-grid">
        <div className="forge-window-bar" aria-hidden="true">
          <span className="dot dot--ember" />
          <span className="dot" />
          <span className="dot" />
          <span className="ml-2 font-mono text-[0.6875rem] text-[oklch(var(--forge-dim))]">
            sync topology — live
          </span>
          <span className="ml-auto font-mono text-[0.6875rem] text-[oklch(var(--forge-dim))]">
            anvil sync v1
          </span>
        </div>
        <svg
          ref={svgRef}
          viewBox="0 0 640 430"
          className="block h-auto w-full"
          role="img"
          aria-hidden="true"
        >
          {/* corner registration ticks */}
          <g aria-hidden="true">
            <path d="M 14 26 L 14 14 L 26 14" className="schematic-tick" fill="none" />
            <path d="M 626 26 L 626 14 L 614 14" className="schematic-tick" fill="none" />
            <path d="M 14 404 L 14 416 L 26 416" className="schematic-tick" fill="none" />
            <path d="M 626 404 L 626 416 L 614 416" className="schematic-tick" fill="none" />
          </g>

          {/* routes */}
          <path d={ROUTES.laptopToWorkstation} className="schematic-route schematic-route--live" />
          <path d={ROUTES.workstationToRelay} className="schematic-route" />
          <path d={ROUTES.phoneToLaptop} className="schematic-route schematic-route--live" />
          <path d={ROUTES.handoff} className="schematic-route" strokeDasharray="3 6" />

          {/* backend relay */}
          <g>
            <circle cx="320" cy="208" r="52" className="schematic-relay-ring" />
            <circle cx="320" cy="208" r="38" className="schematic-relay-core" />
            <path
              d="M 304 200 h32 v6 h-11 v10 h11 v6 h-32 v-6 h11 v-10 h-11 Z"
              className="schematic-relay-mark"
              transform="translate(0 2)"
            />
            <text x="320" y="272" textAnchor="middle" className="schematic-node-title">
              backend relay
            </text>
            <text x="320" y="286" textAnchor="middle" className="schematic-node-label">
              sees shape, not content
            </text>
          </g>

          {/* devices */}
          <g>
            <DeviceGlyph x={112} y={72} kind="laptop" />
            <text x="140" y="140" textAnchor="middle" className="schematic-node-title">
              macbook
            </text>
            <text x="140" y="154" textAnchor="middle" className="schematic-node-label">
              this device
            </text>
          </g>
          <g>
            <DeviceGlyph x={472} y={58} kind="tower" />
            <text x="492" y="134" textAnchor="middle" className="schematic-node-title">
              workstation
            </text>
            <text x="492" y="148" textAnchor="middle" className="schematic-node-label">
              mesh worker
            </text>
          </g>
          <g>
            <DeviceGlyph x={487} y={318} kind="phone" />
            <text x="502" y="392" textAnchor="middle" className="schematic-node-title">
              iphone
            </text>
            <text x="502" y="406" textAnchor="middle" className="schematic-node-label">
              companion
            </text>
          </g>

          {/* packets in flight */}
          <EnvelopePacket path={ROUTES.laptopToWorkstation} dur="6s" begin="0s" />
          <EnvelopePacket path={ROUTES.laptopToWorkstation} dur="6s" begin="-3s" />
          <JobPacket path={ROUTES.relayToWorkstation} dur="7s" begin="-1.5s" />
          <EnvelopePacket path={ROUTES.phoneToLaptop} dur="8s" begin="-4s" />
          <CheckpointPacket path={ROUTES.handoff} dur="9s" begin="-6s" />

          {/* annotations */}
          <text x="212" y="112" className="schematic-annotation schematic-annotation--ember">
            sealed · aes-256-gcm
          </text>
          <text x="452" y="96" textAnchor="end" className="schematic-annotation">
            job · prepare-workspace
          </text>
          <text x="440" y="300" className="schematic-annotation">
            pull · unseal
          </text>
          <text x="320" y="48" textAnchor="middle" className="schematic-annotation">
            checkpoint · handoff
          </text>
          <text x="168" y="176" className="schematic-annotation">
            outbox → seal → push
          </text>

          {/* legend */}
          <g transform="translate(24 396)">
            <rect x="0" y="-5" width="14" height="10" rx="2.5" className="schematic-packet" />
            <text x="20" y="3" className="schematic-caption">sealed envelope</text>
            <rect x="130" y="-3" width="9" height="9" transform="rotate(45 134.5 1.5)" className="schematic-packet-job" />
            <text x="152" y="3" className="schematic-caption">job dispatch</text>
            <rect x="246" y="-3" width="8" height="8" rx="1.5" className="schematic-packet-checkpoint" />
            <text x="262" y="3" className="schematic-caption">checkpoint</text>
            <text x="592" y="3" textAnchor="end" className="schematic-caption">
              fig. 01
            </text>
          </g>
        </svg>
      </div>
    </figure>
  );
}

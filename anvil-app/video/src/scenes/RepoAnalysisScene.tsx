import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
  Sequence,
} from "remotion";
import { loadFont } from "@remotion/google-fonts/IBMPlexSans";
import { loadFont as loadMono } from "@remotion/google-fonts/IBMPlexMono";
import {
  AppShell,
  BG_SECONDARY,
  BG_TERTIARY,
  BG_ELEVATED,
  TEXT_PRIMARY,
  TEXT_SECONDARY,
  TEXT_TERTIARY,
  ACCENT,
  BORDER,
  BORDER_SUBTLE,
  SUCCESS,
} from "./AppShell";

const { fontFamily } = loadFont("normal", {
  weights: ["400", "500", "600", "700"],
  subsets: ["latin"],
});
const { fontFamily: monoFamily } = loadMono("normal", {
  weights: ["400"],
  subsets: ["latin"],
});

const languages = [
  { name: "TypeScript", pct: 72, color: "#3178c6" },
  { name: "CSS", pct: 15, color: "#563d7c" },
  { name: "HTML", pct: 8, color: "#e34c26" },
  { name: "JSON", pct: 5, color: "#94a3b8" },
];

const modules = [
  { path: "src/main/services/", files: 13, purpose: "Core business logic & API integrations" },
  { path: "src/renderer/components/", files: 24, purpose: "React UI components & views" },
  { path: "src/main/db/", files: 3, purpose: "SQLite database & migrations" },
  { path: "src/shared/", files: 2, purpose: "Shared types & constants" },
];

export const RepoAnalysisScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill style={{ fontFamily }}>
      <AppShell activeNav="Code">
        <div style={{ display: "flex", height: "100%", gap: 0 }}>
          {/* Left panel — repo list */}
          <div
            style={{
              width: 300,
              flexShrink: 0,
              borderRight: `1px solid ${BORDER}`,
              padding: 20,
              display: "flex",
              flexDirection: "column",
              gap: 12,
              overflow: "hidden",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="16 18 22 12 16 6" />
                <polyline points="8 6 2 12 8 18" />
              </svg>
              <span style={{ fontSize: 18, fontWeight: 700, color: TEXT_PRIMARY }}>Repositories</span>
            </div>

            {/* Selected repo card */}
            {(() => {
              const cardSpring = spring({ frame, fps, delay: 5, config: { damping: 200 } });
              return (
                <div
                  style={{
                    border: `1px solid ${ACCENT}`,
                    background: "rgba(124,58,237,0.08)",
                    borderRadius: 8,
                    padding: 12,
                    opacity: cardSpring,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: TEXT_PRIMARY }}>anvil</span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={SUCCESS} strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>
                  </div>
                  <div style={{ fontSize: 10, color: TEXT_TERTIARY, marginTop: 4, fontFamily: monoFamily }}>
                    ~/Code/anvil
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                    {["React", "Electron", "TypeScript"].map((t) => (
                      <span
                        key={t}
                        style={{
                          fontSize: 10,
                          background: BG_ELEVATED,
                          color: TEXT_SECONDARY,
                          padding: "2px 8px",
                          borderRadius: 4,
                        }}
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* Other repos */}
            {["campus-api", "student-portal"].map((name, i) => {
              const cardSpring = spring({ frame, fps, delay: 15 + i * 8, config: { damping: 200 } });
              return (
                <div
                  key={name}
                  style={{
                    border: `1px solid ${BORDER}`,
                    background: BG_SECONDARY,
                    borderRadius: 8,
                    padding: 12,
                    opacity: cardSpring,
                  }}
                >
                  <span style={{ fontSize: 14, fontWeight: 500, color: TEXT_PRIMARY }}>{name}</span>
                  <div style={{ fontSize: 10, color: TEXT_TERTIARY, marginTop: 4 }}>3 files · main</div>
                </div>
              );
            })}
          </div>

          {/* Right panel — repo detail */}
          <div
            style={{
              flex: 1,
              padding: 24,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
              gap: 20,
            }}
          >
            {/* Header */}
            {(() => {
              const headSpring = spring({ frame, fps, delay: 10, config: { damping: 200 } });
              return (
                <div style={{ opacity: headSpring }}>
                  <div style={{ fontSize: 20, fontWeight: 700, color: TEXT_PRIMARY }}>anvil</div>
                  <div style={{ fontSize: 11, color: TEXT_TERTIARY, fontFamily: monoFamily, marginTop: 4 }}>
                    ~/Code/anvil
                  </div>
                  <div style={{ display: "flex", gap: 16, marginTop: 10, fontSize: 11, color: TEXT_SECONDARY }}>
                    <span>47 files</span>
                    <span>main branch</span>
                    <span>Last indexed: 2 min ago</span>
                  </div>
                </div>
              );
            })()}

            <div style={{ display: "flex", gap: 20, flex: 1, overflow: "hidden" }}>
              {/* Left column */}
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 16, overflow: "hidden" }}>
                {/* Overview */}
                {(() => {
                  const overSpring = spring({ frame, fps, delay: 20, config: { damping: 200 } });
                  return (
                    <div
                      style={{
                        border: `1px solid ${BORDER}`,
                        background: BG_SECONDARY,
                        borderRadius: 8,
                        padding: 16,
                        opacity: overSpring,
                      }}
                    >
                      <div style={{ fontSize: 13, fontWeight: 600, color: TEXT_PRIMARY, marginBottom: 8 }}>Overview</div>
                      <div style={{ fontSize: 12, color: TEXT_SECONDARY, lineHeight: 1.6 }}>
                        A cross-platform Electron desktop application serving as a developer mission control.
                        Features AI-powered chat with 5 specialized personas, repository analysis,
                        agentic onboarding wizard, work item integration, and documentation management.
                      </div>
                    </div>
                  );
                })()}

                {/* Language breakdown */}
                {(() => {
                  const langSpring = spring({ frame, fps, delay: 30, config: { damping: 200 } });
                  return (
                    <div
                      style={{
                        border: `1px solid ${BORDER}`,
                        background: BG_SECONDARY,
                        borderRadius: 8,
                        padding: 16,
                        opacity: langSpring,
                      }}
                    >
                      <div style={{ fontSize: 13, fontWeight: 600, color: TEXT_PRIMARY, marginBottom: 12 }}>Languages</div>
                      {/* Bar */}
                      <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", gap: 2 }}>
                        {languages.map((lang) => {
                          const barWidth = interpolate(
                            spring({ frame, fps, delay: 35, config: { damping: 200 } }),
                            [0, 1],
                            [0, lang.pct],
                          );
                          return (
                            <div
                              key={lang.name}
                              style={{
                                width: `${barWidth}%`,
                                background: lang.color,
                                borderRadius: 2,
                              }}
                            />
                          );
                        })}
                      </div>
                      <div style={{ display: "flex", gap: 16, marginTop: 10, flexWrap: "wrap" }}>
                        {languages.map((lang) => (
                          <div key={lang.name} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <div style={{ width: 8, height: 8, borderRadius: 2, background: lang.color }} />
                            <span style={{ fontSize: 11, color: TEXT_SECONDARY }}>{lang.name}</span>
                            <span style={{ fontSize: 11, color: TEXT_TERTIARY }}>{lang.pct}%</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {/* Modules */}
                {(() => {
                  const modSpring = spring({ frame, fps, delay: 40, config: { damping: 200 } });
                  return (
                    <div style={{ opacity: modSpring }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: TEXT_PRIMARY, marginBottom: 8 }}>
                        Modules ({modules.length})
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {modules.map((mod, i) => {
                          const mSpring = spring({ frame, fps, delay: 45 + i * 6, config: { damping: 200 } });
                          return (
                            <div
                              key={mod.path}
                              style={{
                                border: `1px solid ${BORDER_SUBTLE}`,
                                background: BG_SECONDARY,
                                borderRadius: 6,
                                padding: "8px 12px",
                                display: "flex",
                                alignItems: "center",
                                gap: 10,
                                opacity: mSpring,
                              }}
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                              </svg>
                              <span style={{ fontSize: 13, fontWeight: 500, color: TEXT_PRIMARY, fontFamily: monoFamily, flex: 1 }}>
                                {mod.path}
                              </span>
                              <span style={{ fontSize: 10, color: TEXT_TERTIARY }}>{mod.files} files</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}
              </div>

              {/* Right column — Architecture diagram mockup */}
              <div style={{ width: 460, flexShrink: 0, display: "flex", flexDirection: "column", gap: 16 }}>
                {(() => {
                  const archSpring = spring({ frame, fps, delay: 25, config: { damping: 200 } });
                  return (
                    <div
                      style={{
                        border: `1px solid ${BORDER}`,
                        background: BG_SECONDARY,
                        borderRadius: 8,
                        padding: 16,
                        flex: 1,
                        opacity: archSpring,
                        display: "flex",
                        flexDirection: "column",
                      }}
                    >
                      <div style={{ fontSize: 13, fontWeight: 600, color: TEXT_PRIMARY, marginBottom: 12 }}>Architecture</div>
                      {/* Mermaid-style diagram mockup */}
                      <div
                        style={{
                          flex: 1,
                          background: "#0d0d12",
                          borderRadius: 6,
                          border: `1px solid ${BORDER_SUBTLE}`,
                          padding: 20,
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: 12,
                        }}
                      >
                        {/* Diagram nodes */}
                        {(() => {
                          const nodes = [
                            { label: "Renderer", x: 180, y: 0, color: "#3b82f6", w: 120 },
                            { label: "Main Process", x: 180, y: 80, color: ACCENT, w: 120 },
                            { label: "Services", x: 50, y: 160, color: "#22c55e", w: 100 },
                            { label: "Database", x: 180, y: 160, color: "#eab308", w: 100 },
                            { label: "APIs", x: 310, y: 160, color: "#8b5cf6", w: 100 },
                          ];
                          const connections = [
                            { from: 0, to: 1 },
                            { from: 1, to: 2 },
                            { from: 1, to: 3 },
                            { from: 1, to: 4 },
                          ];

                          return (
                            <svg width="430" height="220" viewBox="0 0 430 220">
                              {connections.map((conn, ci) => {
                                const fromNode = nodes[conn.from];
                                const toNode = nodes[conn.to];
                                const lineSpring = spring({ frame, fps, delay: 35 + ci * 5, config: { damping: 200 } });
                                const lineOpacity = lineSpring;
                                return (
                                  <line
                                    key={ci}
                                    x1={fromNode.x + fromNode.w / 2}
                                    y1={fromNode.y + 36}
                                    x2={toNode.x + toNode.w / 2}
                                    y2={toNode.y + 4}
                                    stroke={BORDER}
                                    strokeWidth="2"
                                    opacity={lineOpacity}
                                  />
                                );
                              })}
                              {nodes.map((node, ni) => {
                                const nodeSpring = spring({ frame, fps, delay: 30 + ni * 5, config: { damping: 14 } });
                                const nodeScale = interpolate(nodeSpring, [0, 1], [0.5, 1]);
                                return (
                                  <g
                                    key={ni}
                                    transform={`translate(${node.x}, ${node.y})`}
                                    opacity={nodeSpring}
                                  >
                                    <rect
                                      width={node.w}
                                      height={36}
                                      rx="6"
                                      fill={`${node.color}18`}
                                      stroke={`${node.color}55`}
                                      strokeWidth="1.5"
                                    />
                                    <text
                                      x={node.w / 2}
                                      y={22}
                                      textAnchor="middle"
                                      fill={TEXT_PRIMARY}
                                      fontSize="11"
                                      fontWeight="600"
                                      fontFamily={fontFamily}
                                    >
                                      {node.label}
                                    </text>
                                  </g>
                                );
                              })}
                            </svg>
                          );
                        })()}
                      </div>
                    </div>
                  );
                })()}

                {/* Detected patterns */}
                {(() => {
                  const patSpring = spring({ frame, fps, delay: 50, config: { damping: 200 } });
                  const patterns = ["Electron IPC", "React SPA", "SQLite", "REST Client", "JSON-RPC"];
                  return (
                    <div style={{ opacity: patSpring }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: TEXT_PRIMARY, marginBottom: 8 }}>Detected Patterns</div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {patterns.map((p) => (
                          <span
                            key={p}
                            style={{
                              fontSize: 11,
                              background: BG_ELEVATED,
                              color: TEXT_SECONDARY,
                              padding: "4px 10px",
                              borderRadius: 6,
                            }}
                          >
                            {p}
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>
        </div>
      </AppShell>
    </AbsoluteFill>
  );
};

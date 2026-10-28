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
  BG_PRIMARY,
  BG_SECONDARY,
  BG_TERTIARY,
  BG_ELEVATED,
  TEXT_PRIMARY,
  TEXT_SECONDARY,
  TEXT_TERTIARY,
  ACCENT,
  ACCENT_GLOW,
  BORDER,
  BORDER_SUBTLE,
  SUCCESS,
  ERROR,
} from "./AppShell";

const { fontFamily } = loadFont("normal", {
  weights: ["400", "500", "600", "700"],
  subsets: ["latin"],
});
const { fontFamily: monoFamily } = loadMono("normal", {
  weights: ["400"],
  subsets: ["latin"],
});

const WARNING = "#eab308";
const INFO = "#3b82f6";

const steps = [
  { label: "Select Repo", complete: true },
  { label: "Detect", complete: true },
  { label: "Environment", current: true },
  { label: "AGENTS.md", complete: false },
  { label: "Devcontainer", complete: false },
  { label: "Done", complete: false },
];

const artifacts = [
  { name: "AGENTS.md", status: "stale" as const, icon: "file" },
  { name: ".devcontainer", status: "missing" as const, icon: "container" },
  { name: "package.json", status: "found" as const, icon: "file" },
  { name: "tsconfig.json", status: "found" as const, icon: "file" },
  { name: ".env.template", status: "missing" as const, icon: "file" },
];

const envTools = [
  { name: "Node.js 20", installed: true },
  { name: "npm 10", installed: true },
  { name: "Electron", installed: true },
  { name: "Docker Desktop", installed: false },
  { name: "SQL Server", installed: false },
];

const statusColor = (s: "found" | "stale" | "missing") =>
  s === "found" ? SUCCESS : s === "stale" ? WARNING : ERROR;
const statusLabel = (s: "found" | "stale" | "missing") =>
  s === "found" ? "Found" : s === "stale" ? "Stale" : "Missing";

export const OnboardingScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill style={{ fontFamily }}>
      <AppShell activeNav="Onboarding">
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          {/* Step indicator bar */}
          <div
            style={{
              background: BG_SECONDARY,
              borderBottom: `1px solid ${BORDER}`,
              padding: "8px 16px",
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            {steps.map((step, i) => {
              const stepSpring = spring({ frame, fps, delay: 3 + i * 3, config: { damping: 200 } });
              const isCurrent = step.current;
              const isComplete = step.complete;
              return (
                <React.Fragment key={step.label}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "3px 10px",
                      borderRadius: 999,
                      fontSize: 11,
                      fontWeight: 500,
                      background: isCurrent ? ACCENT_GLOW : "transparent",
                      color: isCurrent ? ACCENT : isComplete ? SUCCESS : TEXT_TERTIARY,
                      opacity: stepSpring,
                    }}
                  >
                    {isComplete ? (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={SUCCESS} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : (
                      <div
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: "50%",
                          background: isCurrent ? ACCENT : `${TEXT_TERTIARY}66`,
                        }}
                      />
                    )}
                    {step.label}
                  </div>
                  {i < steps.length - 1 && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={TEXT_TERTIARY} strokeWidth="2">
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  )}
                </React.Fragment>
              );
            })}
          </div>

          {/* Content area */}
          <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
            {/* Main content */}
            <div style={{ flex: 1, padding: 20, overflow: "hidden", display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Section: Artifacts */}
              {(() => {
                const secSpring = spring({ frame, fps, delay: 15, config: { damping: 200 } });
                return (
                  <div style={{ opacity: secSpring }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: TEXT_PRIMARY, marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={INFO} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                      Repository Artifacts
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {artifacts.map((art, i) => {
                        const artSpring = spring({ frame, fps, delay: 20 + i * 5, config: { damping: 200 } });
                        const sc = statusColor(art.status);
                        return (
                          <div
                            key={art.name}
                            style={{
                              border: `1px solid ${BORDER_SUBTLE}`,
                              background: BG_TERTIARY,
                              borderRadius: 6,
                              padding: "8px 12px",
                              display: "flex",
                              alignItems: "center",
                              gap: 10,
                              opacity: artSpring,
                            }}
                          >
                            {art.status === "found" ? (
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={SUCCESS} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                            ) : art.status === "stale" ? (
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={WARNING} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
                            ) : (
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={ERROR} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                            )}
                            <span style={{ fontSize: 13, fontWeight: 500, color: TEXT_PRIMARY, fontFamily: monoFamily, flex: 1 }}>
                              {art.name}
                            </span>
                            <span style={{ fontSize: 10, color: sc, fontWeight: 600 }}>{statusLabel(art.status)}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              {/* Section: Environment Tools */}
              {(() => {
                const secSpring = spring({ frame, fps, delay: 45, config: { damping: 200 } });
                return (
                  <div style={{ opacity: secSpring }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: TEXT_PRIMARY, marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={SUCCESS} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0l1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16" />
                      </svg>
                      Environment Dependencies
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {envTools.map((tool, i) => {
                        const toolSpring = spring({ frame, fps, delay: 50 + i * 4, config: { damping: 200 } });
                        return (
                          <div
                            key={tool.name}
                            style={{
                              border: `1px solid ${BORDER_SUBTLE}`,
                              background: BG_TERTIARY,
                              borderRadius: 6,
                              padding: "8px 12px",
                              display: "flex",
                              alignItems: "center",
                              gap: 10,
                              opacity: toolSpring,
                            }}
                          >
                            {tool.installed ? (
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={SUCCESS} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                            ) : (
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={ERROR} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                            )}
                            <span style={{ fontSize: 13, fontWeight: 500, color: TEXT_PRIMARY, flex: 1 }}>{tool.name}</span>
                            <span style={{ fontSize: 10, color: tool.installed ? SUCCESS : ERROR, fontWeight: 600 }}>
                              {tool.installed ? "Installed" : "Not found"}
                            </span>
                            {!tool.installed && (
                              <span
                                style={{
                                  fontSize: 10,
                                  color: ACCENT,
                                  border: `1px solid ${ACCENT}55`,
                                  padding: "2px 8px",
                                  borderRadius: 4,
                                  cursor: "pointer",
                                }}
                              >
                                Install
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* Right sidebar — Quick Summary */}
            <div
              style={{
                width: 220,
                flexShrink: 0,
                borderLeft: `1px solid ${BORDER}`,
                background: BG_SECONDARY,
                padding: 16,
                display: "flex",
                flexDirection: "column",
                gap: 16,
              }}
            >
              {(() => {
                const sideSpring = spring({ frame, fps, delay: 25, config: { damping: 200 } });
                return (
                  <>
                    <div
                      style={{
                        border: `1px solid ${BORDER}`,
                        background: BG_TERTIARY,
                        borderRadius: 8,
                        padding: 12,
                        opacity: sideSpring,
                      }}
                    >
                      <div style={{ fontSize: 10, fontWeight: 600, color: TEXT_TERTIARY, textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>
                        Quick Summary
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                        <span style={{ fontSize: 11, color: TEXT_SECONDARY }}>Tools</span>
                        <span style={{ fontSize: 11, color: TEXT_PRIMARY, fontWeight: 600 }}>3/5</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span style={{ fontSize: 11, color: TEXT_SECONDARY }}>Artifacts</span>
                        <span style={{ fontSize: 11, color: TEXT_PRIMARY, fontWeight: 600 }}>2/5</span>
                      </div>
                    </div>

                    <div
                      style={{
                        border: `1px solid ${BORDER}`,
                        background: BG_TERTIARY,
                        borderRadius: 8,
                        padding: 12,
                        opacity: sideSpring,
                      }}
                    >
                      <div style={{ fontSize: 10, fontWeight: 600, color: TEXT_TERTIARY, textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>
                        Suggested Actions
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {["Regenerate AGENTS.md", "Create .devcontainer", "Create .env.template"].map((action) => (
                          <div key={action} style={{ fontSize: 11, color: TEXT_SECONDARY }}>
                            • {action}
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                );
              })()}
            </div>
          </div>

          {/* Bottom action bar */}
          <div
            style={{
              borderTop: `1px solid ${BORDER}`,
              background: BG_SECONDARY,
              padding: "8px 16px",
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
            }}
          >
            <div
              style={{
                padding: "6px 16px",
                border: `1px solid ${BORDER}`,
                borderRadius: 6,
                fontSize: 12,
                color: TEXT_SECONDARY,
              }}
            >
              Back
            </div>
            <div
              style={{
                padding: "6px 16px",
                background: ACCENT,
                borderRadius: 6,
                fontSize: 12,
                color: "white",
                fontWeight: 600,
              }}
            >
              Generate AGENTS.md →
            </div>
          </div>
        </div>
      </AppShell>
    </AbsoluteFill>
  );
};

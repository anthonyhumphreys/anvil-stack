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

const PERSONA_CODER = "#22c55e";
const PERSONA_ARCHITECT = "#3b82f6";
const PERSONA_SECURITY = "#ef4444";
const PERSONA_REVIEWER = "#eab308";
const PERSONA_DOCS = "#8b5cf6";

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  delay: number;
};

type ChatEvent = {
  type: "file_read" | "file_edit" | "command";
  label: string;
  delay: number;
  statusColor: string;
};

const messages: ChatMessage[] = [
  { role: "user", text: "Explain the architecture of this project and how the main process communicates with the renderer.", delay: 5 },
  { role: "assistant", text: "This is an Electron application using a multi-process architecture:\n\n• Main Process — handles all Node.js operations, API calls (Azure AI Foundry, ADO, Confluence), database access, and Codex CLI management.\n\n• Renderer Process — pure React SPA with context isolation. Communicates via IPC bridges defined in src/preload/.\n\n• JSON-RPC — used for streaming chat with Codex app-server instances (one per persona + repo combination).", delay: 25 },
];

const events: ChatEvent[] = [
  { type: "file_read", label: "src/main/index.ts", delay: 20, statusColor: "#3b82f6" },
  { type: "file_read", label: "src/preload/index.ts", delay: 22, statusColor: "#3b82f6" },
  { type: "file_read", label: "src/shared/types.ts", delay: 24, statusColor: "#3b82f6" },
];

const personaDropdown = [
  { name: "Coder", color: PERSONA_CODER, desc: "Read/write/execute" },
  { name: "Architect", color: PERSONA_ARCHITECT, desc: "Read-only analysis" },
  { name: "Security", color: PERSONA_SECURITY, desc: "Security scanning" },
  { name: "Reviewer", color: PERSONA_REVIEWER, desc: "Code review" },
  { name: "Docs", color: PERSONA_DOCS, desc: "Documentation" },
];

export const PersonasScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const dropdownSpring = spring({ frame, fps, delay: 60, config: { damping: 200 } });
  const showDropdown = frame >= 60 && frame < 120;

  return (
    <AbsoluteFill style={{ fontFamily }}>
      <AppShell activeNav="Chat">
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          {/* Chat header */}
          <div
            style={{
              padding: "8px 16px",
              borderBottom: `1px solid ${BORDER}`,
              background: BG_SECONDARY,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              position: "relative",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              <span style={{ fontSize: 17, fontWeight: 600, color: TEXT_PRIMARY }}>Chat</span>

              {/* Persona selector */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  border: `1px solid ${PERSONA_ARCHITECT}60`,
                  borderRadius: 6,
                  padding: "4px 10px",
                  cursor: "pointer",
                }}
              >
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: PERSONA_ARCHITECT }} />
                <span style={{ fontSize: 13, color: TEXT_PRIMARY, fontWeight: 500 }}>Architect</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={TEXT_TERTIARY} strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
              </div>

              <span
                style={{
                  fontSize: 11,
                  background: BG_TERTIARY,
                  color: TEXT_SECONDARY,
                  padding: "2px 8px",
                  borderRadius: 4,
                }}
              >
                anvil
              </span>
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                border: `1px solid ${BORDER}`,
                borderRadius: 6,
                padding: "4px 8px",
                cursor: "pointer",
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={TEXT_SECONDARY} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
              <span style={{ fontSize: 11, color: TEXT_SECONDARY }}>New Session</span>
            </div>

            {/* Persona dropdown */}
            {showDropdown && (
              <div
                style={{
                  position: "absolute",
                  left: 160,
                  top: 44,
                  width: 256,
                  background: BG_ELEVATED,
                  border: `1px solid ${BORDER}`,
                  borderRadius: 6,
                  padding: 4,
                  zIndex: 10,
                  boxShadow: "0 8px 30px rgba(0,0,0,0.4)",
                  opacity: dropdownSpring,
                }}
              >
                {personaDropdown.map((p, i) => {
                  const itemSpring = spring({ frame, fps, delay: 62 + i * 4, config: { damping: 200 } });
                  const isSelected = p.name === "Architect";
                  return (
                    <div
                      key={p.name}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "8px 12px",
                        borderRadius: 4,
                        background: isSelected ? BG_TERTIARY : "transparent",
                        opacity: itemSpring,
                      }}
                    >
                      <div style={{ width: 8, height: 8, borderRadius: "50%", background: p.color, flexShrink: 0 }} />
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 600, color: p.color }}>{p.name}</div>
                        <div style={{ fontSize: 10, color: TEXT_TERTIARY }}>{p.desc}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Messages area */}
          <div
            style={{
              flex: 1,
              padding: 16,
              display: "flex",
              flexDirection: "column",
              gap: 12,
              overflow: "hidden",
            }}
          >
            {/* Events */}
            {events.map((evt, i) => {
              const evtSpring = spring({ frame, fps, delay: evt.delay, config: { damping: 200 } });
              return (
                <Sequence key={i} from={evt.delay} layout="none">
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 12px",
                      border: `1px solid ${BORDER_SUBTLE}`,
                      background: BG_TERTIARY,
                      borderRadius: 6,
                      opacity: evtSpring,
                      alignSelf: "flex-start",
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={evt.statusColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    <span style={{ fontSize: 11, color: TEXT_SECONDARY }}>Read</span>
                    <span style={{ fontSize: 11, color: TEXT_PRIMARY, fontFamily: monoFamily }}>{evt.label}</span>
                  </div>
                </Sequence>
              );
            })}

            {/* Chat messages */}
            {messages.map((msg, i) => {
              const msgSpring = spring({ frame, fps, delay: msg.delay, config: { damping: 200 } });
              const isUser = msg.role === "user";
              return (
                <Sequence key={i} from={msg.delay} layout="none">
                  <div
                    style={{
                      display: "flex",
                      justifyContent: isUser ? "flex-end" : "flex-start",
                      opacity: msgSpring,
                    }}
                  >
                    <div
                      style={{
                        maxWidth: "75%",
                        padding: "8px 12px",
                        borderRadius: 8,
                        background: isUser ? ACCENT : BG_TERTIARY,
                        color: isUser ? "white" : TEXT_PRIMARY,
                        fontSize: 13,
                        lineHeight: 1.6,
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {msg.text}
                    </div>
                  </div>
                </Sequence>
              );
            })}
          </div>

          {/* Input area */}
          <div
            style={{
              borderTop: `1px solid ${BORDER}`,
              background: BG_SECONDARY,
              padding: 12,
              display: "flex",
              alignItems: "flex-end",
              gap: 8,
            }}
          >
            <div
              style={{
                flex: 1,
                padding: "8px 12px",
                border: `1px solid ${BORDER}`,
                background: BG_PRIMARY,
                borderRadius: 6,
                fontSize: 13,
                color: TEXT_TERTIARY,
                minHeight: 36,
              }}
            >
              Ask the Architect about this codebase...
            </div>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 6,
                background: PERSONA_ARCHITECT,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </div>
          </div>
        </div>
      </AppShell>
    </AbsoluteFill>
  );
};

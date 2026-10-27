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

const INFO = "#3b82f6";
const WARNING = "#eab308";

type WorkItem = {
  id: number;
  title: string;
  type: "Bug" | "Feature" | "Task";
  priority: 1 | 2 | 3;
  state: string;
};

const workItems: WorkItem[] = [
  { id: 4521, title: "SSO callback fails on expired refresh token", type: "Bug", priority: 1, state: "Active" },
  { id: 4518, title: "Add role-based dashboard filtering", type: "Feature", priority: 2, state: "Active" },
  { id: 4515, title: "Migrate user-prefs to new schema", type: "Task", priority: 2, state: "New" },
  { id: 4512, title: "Course search returns stale results after cache TTL", type: "Bug", priority: 3, state: "Active" },
  { id: 4509, title: "Implement bulk-export for assessment data", type: "Feature", priority: 3, state: "New" },
];

const typeConfig = {
  Bug: { color: ERROR, icon: "bug" },
  Feature: { color: INFO, icon: "lightbulb" },
  Task: { color: SUCCESS, icon: "check" },
};

const priorityColor = (p: number) => p === 1 ? ERROR : p === 2 ? WARNING : INFO;

export const IntegrationsScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const showPanel = frame >= 35;
  const panelSpring = spring({ frame, fps, delay: 35, config: { damping: 200 } });

  return (
    <AbsoluteFill style={{ fontFamily }}>
      <AppShell activeNav="Work Items">
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          {/* Header */}
          <div
            style={{
              padding: "8px 16px",
              borderBottom: `1px solid ${BORDER}`,
              background: BG_SECONDARY,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 11l3 3L22 4" />
                <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
              </svg>
              <span style={{ fontSize: 17, fontWeight: 600, color: TEXT_PRIMARY }}>Work Items</span>
              <span style={{ fontSize: 11, color: TEXT_TERTIARY }}>{workItems.length} items</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, border: `1px solid ${BORDER}`, borderRadius: 6, padding: "4px 8px" }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={TEXT_SECONDARY} strokeWidth="2"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
              <span style={{ fontSize: 11, color: TEXT_SECONDARY }}>Refresh</span>
            </div>
          </div>

          {/* Search */}
          <div style={{ background: BG_SECONDARY, padding: "6px 16px", borderBottom: `1px solid ${BORDER_SUBTLE}` }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                border: `1px solid ${BORDER}`,
                background: BG_PRIMARY,
                borderRadius: 6,
                padding: "6px 10px",
                gap: 8,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={TEXT_TERTIARY} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <span style={{ fontSize: 13, color: TEXT_TERTIARY }}>Search work items...</span>
            </div>
          </div>

          {/* Content */}
          <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
            {/* List */}
            <div style={{ flex: 1, overflow: "hidden" }}>
              {workItems.map((item, i) => {
                const itemSpring = spring({ frame, fps, delay: 8 + i * 4, config: { damping: 200 } });
                const isSelected = i === 0;
                const tc = typeConfig[item.type];
                return (
                  <div
                    key={item.id}
                    style={{
                      padding: "10px 16px",
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      borderBottom: `1px solid ${BORDER_SUBTLE}`,
                      background: isSelected ? BG_TERTIARY : "transparent",
                      opacity: itemSpring,
                    }}
                  >
                    {/* Priority dot */}
                    <div
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: priorityColor(item.priority),
                        flexShrink: 0,
                      }}
                    />

                    {/* ID */}
                    <span style={{ fontSize: 11, fontFamily: monoFamily, color: TEXT_TERTIARY, flexShrink: 0 }}>
                      #{item.id}
                    </span>

                    {/* Type badge */}
                    <span
                      style={{
                        fontSize: 10,
                        border: `1px solid ${tc.color}55`,
                        color: tc.color,
                        padding: "1px 6px",
                        borderRadius: 999,
                        flexShrink: 0,
                        fontWeight: 600,
                      }}
                    >
                      {item.type}
                    </span>

                    {/* Title */}
                    <span style={{ flex: 1, fontSize: 13, color: TEXT_PRIMARY, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {item.title}
                    </span>

                    {/* State */}
                    <span style={{ fontSize: 11, color: TEXT_TERTIARY, flexShrink: 0 }}>{item.state}</span>

                    {/* Actions */}
                    <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                      <span
                        style={{
                          fontSize: 10,
                          color: INFO,
                          padding: "2px 6px",
                          borderRadius: 4,
                          cursor: "pointer",
                          fontWeight: 500,
                        }}
                      >
                        Plan
                      </span>
                      <span
                        style={{
                          fontSize: 10,
                          color: SUCCESS,
                          padding: "2px 6px",
                          borderRadius: 4,
                          cursor: "pointer",
                          fontWeight: 500,
                        }}
                      >
                        Fix
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Generated content panel */}
            {showPanel && (
              <div
                style={{
                  width: 420,
                  flexShrink: 0,
                  borderLeft: `1px solid ${BORDER}`,
                  background: BG_SECONDARY,
                  display: "flex",
                  flexDirection: "column",
                  opacity: panelSpring,
                }}
              >
                {/* Panel header */}
                <div
                  style={{
                    padding: "8px 12px",
                    borderBottom: `1px solid ${BORDER_SUBTLE}`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={INFO} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    <span style={{ fontSize: 12, fontWeight: 600, color: TEXT_PRIMARY }}>Implementation Plan</span>
                  </div>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={TEXT_TERTIARY} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </div>

                {/* Meta */}
                <div style={{ padding: "6px 12px", borderBottom: `1px solid ${BORDER_SUBTLE}` }}>
                  <span style={{ fontSize: 11, color: TEXT_TERTIARY }}>
                    #4521 — SSO callback fails on expired refresh token
                  </span>
                </div>

                {/* Content */}
                <div style={{ flex: 1, padding: 12, overflow: "hidden" }}>
                  {(() => {
                    const contentSpring = spring({ frame, fps, delay: 42, config: { damping: 200 } });
                    const planText = `## Analysis
The SSO refresh token flow in src/main/services/auth-service.ts
doesn't handle the case where the refresh token itself has expired.

## Steps
1. Add token expiry check in \`refreshSession()\`
2. Implement re-authentication flow when refresh fails
3. Update error handler to surface auth-expired to UI
4. Add retry logic with exponential backoff

## Files to Modify
- src/main/services/auth-service.ts
- src/preload/auth-bridge.ts
- src/renderer/components/auth/LoginPrompt.tsx

## Risk Assessment
Medium — changes affect auth flow, requires careful testing
with expired tokens in staging environment.`;

                    return (
                      <pre
                        style={{
                          fontFamily: monoFamily,
                          fontSize: 11,
                          color: TEXT_PRIMARY,
                          whiteSpace: "pre-wrap",
                          lineHeight: 1.6,
                          background: BG_PRIMARY,
                          border: `1px solid ${BORDER}`,
                          borderRadius: 6,
                          padding: 12,
                          margin: 0,
                          opacity: contentSpring,
                          height: "100%",
                          overflow: "hidden",
                        }}
                      >
                        {planText}
                      </pre>
                    );
                  })()}
                </div>
              </div>
            )}
          </div>
        </div>
      </AppShell>
    </AbsoluteFill>
  );
};

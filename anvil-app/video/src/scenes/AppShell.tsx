import React from "react";
import {
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
} from "remotion";

const SIDEBAR_WIDTH = 220;
const TITLEBAR_HEIGHT = 40;
const STATUSBAR_HEIGHT = 24;

const BG_PRIMARY = "#0a0a0c";
const BG_SECONDARY = "#111114";
const BG_TERTIARY = "#18181c";
const BG_ELEVATED = "#1e1e24";
const TEXT_PRIMARY = "#e8e8ec";
const TEXT_SECONDARY = "#8e8e9a";
const TEXT_TERTIARY = "#5a5a66";
const ACCENT = "#7c3aed";
const ACCENT_GLOW = "rgba(124, 58, 237, 0.15)";
const BORDER = "#2a2a32";
const BORDER_SUBTLE = "#1f1f28";
const SUCCESS = "#22c55e";
const ERROR = "#ef4444";

type NavItem = {
  label: string;
  icon: React.ReactNode;
  active?: boolean;
};

const navItems: NavItem[] = [
  {
    label: "Code",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="16 18 22 12 16 6" />
        <polyline points="8 6 2 12 8 18" />
      </svg>
    ),
  },
  {
    label: "Chat",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
  {
    label: "Onboarding",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
      </svg>
    ),
  },
  {
    label: "Work Items",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 11l3 3L22 4" />
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </svg>
    ),
  },
  {
    label: "Documentation",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
      </svg>
    ),
  },
];

type AppShellProps = {
  activeNav: string;
  children: React.ReactNode;
  animateIn?: boolean;
};

export const AppShell: React.FC<AppShellProps> = ({
  activeNav,
  children,
  animateIn = true,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const shellSpring = animateIn
    ? spring({ frame, fps, config: { damping: 200 } })
    : 1;
  const shellScale = interpolate(shellSpring, [0, 1], [0.92, 1]);
  const shellOpacity = shellSpring;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        background: "linear-gradient(135deg, #0a0a1a 0%, #0d1117 100%)",
        padding: 40,
      }}
    >
      <div
        style={{
          width: 1840,
          height: 1000,
          borderRadius: 12,
          overflow: "hidden",
          border: `1px solid ${BORDER}`,
          boxShadow: "0 40px 100px rgba(0,0,0,0.6)",
          display: "flex",
          flexDirection: "column",
          opacity: shellOpacity,
          transform: `scale(${shellScale})`,
        }}
      >
        {/* Window chrome */}
        <div
          style={{
            height: TITLEBAR_HEIGHT,
            background: BG_SECONDARY,
            borderBottom: `1px solid ${BORDER}`,
            display: "flex",
            alignItems: "center",
            padding: "0 16px",
            gap: 8,
            flexShrink: 0,
          }}
        >
          <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#ff5f57" }} />
          <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#febc2e" }} />
          <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#28c840" }} />
        </div>

        {/* Main area */}
        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
          {/* Sidebar */}
          <div
            style={{
              width: SIDEBAR_WIDTH,
              flexShrink: 0,
              background: BG_SECONDARY,
              borderRight: `1px solid ${BORDER}`,
              display: "flex",
              flexDirection: "column",
            }}
          >
            {/* Branding */}
            <div style={{ padding: "16px 16px 12px" }}>
              <div
                style={{
                  fontSize: 18,
                  fontWeight: 700,
                  color: ACCENT,
                  lineHeight: 1,
                }}
              >
                Anvil
              </div>
              <div
                style={{
                  fontSize: 10,
                  color: TEXT_TERTIARY,
                  marginTop: 4,
                }}
              >
                AnthonyHumphreys.dev
              </div>
            </div>

            {/* Nav items */}
            <div
              style={{
                flex: 1,
                padding: "0 8px",
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              {navItems.map((item) => {
                const isActive = item.label === activeNav;
                return (
                  <div
                    key={item.label}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "8px 12px",
                      borderRadius: 6,
                      borderLeft: `2px solid ${isActive ? ACCENT : "transparent"}`,
                      background: isActive ? ACCENT_GLOW : "transparent",
                      color: isActive ? ACCENT : TEXT_SECONDARY,
                      fontSize: 14,
                      cursor: "pointer",
                    }}
                  >
                    {item.icon}
                    <span style={{ fontWeight: isActive ? 600 : 400 }}>{item.label}</span>
                  </div>
                );
              })}
            </div>

            {/* Footer */}
            <div
              style={{
                borderTop: `1px solid ${BORDER_SUBTLE}`,
                padding: 12,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <div style={{ display: "flex", gap: 4 }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: SUCCESS }} />
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: SUCCESS }} />
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: TEXT_TERTIARY }} />
              </div>
              <span style={{ fontSize: 10, color: TEXT_TERTIARY }}>Settings</span>
            </div>
          </div>

          {/* Content */}
          <div
            style={{
              flex: 1,
              background: BG_PRIMARY,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
          >
            {children}
          </div>
        </div>

        {/* Status bar */}
        <div
          style={{
            height: STATUSBAR_HEIGHT,
            background: BG_SECONDARY,
            borderTop: `1px solid ${BORDER_SUBTLE}`,
            padding: "0 16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 10, color: TEXT_TERTIARY }}>Anvil v0.1.0</span>
          <span style={{ fontSize: 10, color: TEXT_TERTIARY }}>Connected · macOS</span>
        </div>
      </div>
    </div>
  );
};

export {
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
  SIDEBAR_WIDTH,
};

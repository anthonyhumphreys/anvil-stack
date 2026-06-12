import React, { type CSSProperties, type ReactNode } from 'react';
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { loadFont as loadSans } from '@remotion/google-fonts/IBMPlexSans';
import { loadFont as loadMono } from '@remotion/google-fonts/IBMPlexMono';

const { fontFamily: sansFamily } = loadSans('normal', {
  weights: ['400', '500', '600', '700'],
  subsets: ['latin'],
});

const { fontFamily: monoFamily } = loadMono('normal', {
  weights: ['400', '500'],
  subsets: ['latin'],
});

export const FONTS = {
  display: sansFamily,
  body: sansFamily,
  mono: monoFamily,
};

export const COLORS = {
  bg: '#05070d',
  bgDeep: '#0a0f18',
  panel: '#0f1620',
  panelRaised: '#151e2c',
  panelSoft: '#1a2636',
  line: 'rgba(255, 255, 255, 0.09)',
  lineSoft: 'rgba(255, 255, 255, 0.05)',
  text: '#f8fafc',
  textSecondary: '#cbd5e1',
  textMuted: '#8190a7',
  red: '#ff7a2f',
  cyan: '#2dd4ff',
  amber: '#ffd43b',
  green: '#35d07f',
  violet: '#a78bfa',
};

export type Tone = 'red' | 'cyan' | 'amber' | 'green' | 'violet';

type AppFrameProps = {
  activeNav: string;
  children: ReactNode;
  workspaceName?: string;
  workspaceMeta?: string;
  footerText?: string;
};

const NAV_ITEMS = [
  { label: 'Repositories', short: 'RP', tone: 'cyan' as const },
  { label: 'Chat', short: 'CH', tone: 'violet' as const },
  { label: 'Embedded IDE', short: 'ID', tone: 'cyan' as const },
  { label: 'DB Insights', short: 'DB', tone: 'amber' as const },
  { label: 'Onboarding', short: 'ON', tone: 'amber' as const },
  { label: 'Work Items', short: 'WI', tone: 'amber' as const },
  { label: 'Security', short: 'SC', tone: 'red' as const },
  { label: 'Code Review', short: 'CR', tone: 'cyan' as const },
  { label: 'Documentation', short: 'DC', tone: 'green' as const },
  { label: 'ADRs', short: 'AR', tone: 'violet' as const },
  { label: 'Diagrams', short: 'DG', tone: 'violet' as const },
  { label: 'Governance', short: 'GV', tone: 'red' as const },
  { label: 'Browser', short: 'BR', tone: 'cyan' as const },
  { label: 'Git', short: 'GT', tone: 'green' as const },
  { label: 'Automations', short: 'AU', tone: 'green' as const },
  { label: 'Diagnostics', short: 'DX', tone: 'red' as const },
  { label: 'Mobile', short: 'MB', tone: 'cyan' as const },
  { label: 'Data & Compliance', short: 'CP', tone: 'amber' as const },
];

const TONE_COLORS: Record<Tone, string> = {
  red: COLORS.red,
  cyan: COLORS.cyan,
  amber: COLORS.amber,
  green: COLORS.green,
  violet: COLORS.violet,
};

export const toRgba = (hex: string, alpha: number): string => {
  const normalized = hex.replace('#', '');
  const value =
    normalized.length === 3
      ? normalized
          .split('')
          .map((char) => char + char)
          .join('')
      : normalized;

  const number = Number.parseInt(value, 16);
  const r = (number >> 16) & 255;
  const g = (number >> 8) & 255;
  const b = number & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

export const stagger = (frame: number, fps: number, delay = 0, damping = 18): number =>
  spring({
    frame: frame - delay,
    fps,
    config: { damping, mass: 0.8, stiffness: 110 },
  });

export const rise = (progress: number, distance = 26): string =>
  `translateY(${interpolate(progress, [0, 1], [distance, 0])}px)`;

export const FrostPanel: React.FC<{
  children: ReactNode;
  style?: CSSProperties;
}> = ({ children, style }) => (
  <div
    style={{
      background: `linear-gradient(180deg, ${toRgba(COLORS.panelRaised, 0.95)} 0%, ${toRgba(
        COLORS.panel,
        0.92,
      )} 100%)`,
      border: `1px solid ${COLORS.line}`,
      boxShadow: `0 28px 80px ${toRgba('#000000', 0.38)}`,
      borderRadius: 28,
      backdropFilter: 'blur(18px)',
      ...style,
    }}
  >
    {children}
  </div>
);

export const MetricPill: React.FC<{
  label: string;
  tone?: Tone;
  style?: CSSProperties;
}> = ({ label, tone = 'cyan', style }) => {
  const color = TONE_COLORS[tone];

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 14px',
        borderRadius: 999,
        border: `1px solid ${toRgba(color, 0.35)}`,
        background: toRgba(color, 0.12),
        color: COLORS.text,
        ...style,
      }}
    >
      <div
        style={{
          width: 9,
          height: 9,
          borderRadius: '50%',
          background: color,
          boxShadow: `0 0 20px ${toRgba(color, 0.55)}`,
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontSize: 15,
          fontWeight: 600,
          fontFamily: FONTS.body,
          letterSpacing: -0.2,
        }}
      >
        {label}
      </span>
    </div>
  );
};

export const StatCard: React.FC<{
  label: string;
  value: string;
  detail?: string;
  tone?: Tone;
  style?: CSSProperties;
}> = ({ label, value, detail, tone = 'cyan', style }) => {
  const color = TONE_COLORS[tone];

  return (
    <FrostPanel
      style={{
        padding: '18px 20px',
        borderColor: toRgba(color, 0.22),
        ...style,
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: COLORS.textMuted,
          textTransform: 'uppercase',
          letterSpacing: 1.5,
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 10,
          fontSize: 34,
          lineHeight: 1,
          fontWeight: 700,
          color: COLORS.text,
          letterSpacing: -1.4,
        }}
      >
        {value}
      </div>
      {detail ? (
        <div
          style={{
            marginTop: 8,
            fontSize: 14,
            color: COLORS.textSecondary,
            lineHeight: 1.45,
          }}
        >
          {detail}
        </div>
      ) : null}
    </FrostPanel>
  );
};

export const SectionHeader: React.FC<{
  kicker: string;
  title: ReactNode;
  body: string;
  accent?: string;
  width?: number;
}> = ({ kicker, title, body, accent = COLORS.red, width = 760 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = stagger(frame, fps, 2, 20);

  return (
    <div
      style={{
        maxWidth: width,
        opacity: progress,
        transform: rise(progress, 24),
      }}
    >
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 14px',
          borderRadius: 999,
          border: `1px solid ${toRgba(accent, 0.28)}`,
          background: toRgba(accent, 0.1),
          color: COLORS.text,
          fontSize: 14,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: 1.8,
        }}
      >
        <div
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: accent,
            boxShadow: `0 0 20px ${toRgba(accent, 0.55)}`,
          }}
        />
        {kicker}
      </div>

      <div
        style={{
          marginTop: 18,
          fontFamily: FONTS.display,
          fontSize: 78,
          lineHeight: 0.94,
          fontWeight: 700,
          letterSpacing: -3.6,
          color: COLORS.text,
        }}
      >
        {title}
      </div>

      <div
        style={{
          marginTop: 22,
          fontSize: 22,
          lineHeight: 1.45,
          color: COLORS.textSecondary,
          maxWidth: width - 40,
        }}
      >
        {body}
      </div>
    </div>
  );
};

export const ScreenBackground: React.FC<{
  children: ReactNode;
  accent?: string;
  secondary?: string;
  ghostLabel?: string;
}> = ({ children, accent = COLORS.red, secondary = COLORS.cyan, ghostLabel }) => {
  const frame = useCurrentFrame();
  const xShift = interpolate(frame, [0, 210], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(145deg, ${COLORS.bg} 0%, ${COLORS.bgDeep} 62%, ${COLORS.bg} 100%)`,
        fontFamily: FONTS.body,
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: -180,
          background: `
            radial-gradient(circle at ${18 + xShift * 11}% ${18 + xShift * 6}%, ${toRgba(
              accent,
              0.24,
            )} 0%, transparent 28%),
            radial-gradient(circle at ${84 - xShift * 8}% ${22 + xShift * 4}%, ${toRgba(
              secondary,
              0.18,
            )} 0%, transparent 28%),
            radial-gradient(circle at ${48 + xShift * 4}% ${78 - xShift * 5}%, ${toRgba(
              COLORS.red,
              0.1,
            )} 0%, transparent 32%)
          `,
        }}
      />

      <div
        style={{
          position: 'absolute',
          inset: 0,
          opacity: 0.16,
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.075) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.075) 1px, transparent 1px)',
          backgroundSize: '140px 140px',
          maskImage:
            'radial-gradient(circle at center, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.45) 68%, transparent 100%)',
        }}
      />

      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'linear-gradient(180deg, rgba(255,255,255,0.06) 0%, transparent 8%, transparent 92%, rgba(255,255,255,0.05) 100%)',
          opacity: 0.22,
        }}
      />

      {ghostLabel ? (
        <div
          style={{
            position: 'absolute',
            top: 28,
            right: 52,
            fontSize: 184,
            fontWeight: 700,
            letterSpacing: -7,
            color: 'rgba(255,255,255,0.05)',
            textTransform: 'uppercase',
            userSelect: 'none',
          }}
        >
          {ghostLabel}
        </div>
      ) : null}

      {children}
    </AbsoluteFill>
  );
};

const SidebarBadge: React.FC<{ short: string; tone: Tone }> = ({ short, tone }) => {
  const color = TONE_COLORS[tone];

  return (
    <div
      style={{
        width: 24,
        height: 24,
        borderRadius: 8,
        border: `1px solid ${toRgba(color, 0.3)}`,
        background: toRgba(color, 0.12),
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color,
        fontSize: 10,
        fontWeight: 700,
        fontFamily: FONTS.mono,
        flexShrink: 0,
      }}
    >
      {short}
    </div>
  );
};

export const AppFrame: React.FC<AppFrameProps> = ({
  activeNav,
  children,
  workspaceName = 'North Star Platform',
  workspaceMeta = '3 repositories indexed · run targets detected',
  footerText = 'anthonyhumphreys.dev · @aphumphreys',
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const reveal = stagger(frame, fps, 4, 20);
  const scale = interpolate(reveal, [0, 1], [0.95, 1]);

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 44,
      }}
    >
      <div
        style={{
          width: 1820,
          height: 980,
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 34,
          overflow: 'hidden',
          border: `1px solid ${COLORS.line}`,
          boxShadow: `0 40px 120px ${toRgba('#000000', 0.45)}`,
          background: toRgba(COLORS.panel, 0.9),
          opacity: reveal,
          transform: `scale(${scale}) ${rise(reveal, 24)}`,
        }}
      >
        <div
          style={{
            height: 44,
            background: `linear-gradient(180deg, ${toRgba(COLORS.panelRaised, 0.98)} 0%, ${toRgba(
              COLORS.panel,
              0.94,
            )} 100%)`,
            borderBottom: `1px solid ${COLORS.line}`,
            display: 'flex',
            alignItems: 'center',
            padding: '0 20px',
            gap: 8,
          }}
        >
          {['#ff5f57', '#febc2e', '#28c840'].map((color) => (
            <div
              key={color}
              style={{
                width: 12,
                height: 12,
                borderRadius: '50%',
                background: color,
              }}
            />
          ))}
          <div
            style={{
              marginLeft: 14,
              fontSize: 12,
              color: COLORS.textMuted,
              fontFamily: FONTS.mono,
              letterSpacing: 0.2,
            }}
          >
            anvil://workspace/{workspaceName.toLowerCase().replace(/\s+/g, '-')}
          </div>
        </div>

        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          <div
            style={{
              width: 272,
              background: `linear-gradient(180deg, ${toRgba(COLORS.panelRaised, 0.94)} 0%, ${toRgba(
                COLORS.panel,
                0.94,
              )} 100%)`,
              borderRight: `1px solid ${COLORS.line}`,
              padding: '16px 14px 12px',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div>
              <div
                style={{
              fontSize: 28,
              lineHeight: 1,
              fontWeight: 700,
              color: COLORS.text,
              letterSpacing: -1.8,
            }}
          >
                <span style={{ color: COLORS.red }}>◆</span> Anvil
              </div>
              <div
                style={{
                  marginTop: 6,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  color: COLORS.textMuted,
                  fontSize: 11,
                }}
              >
                {footerText}
              </div>
            </div>

            <FrostPanel style={{ padding: '14px 14px 12px', borderRadius: 22 }}>
              <div
                style={{
                  fontSize: 11,
                  color: COLORS.textMuted,
                  textTransform: 'uppercase',
                  letterSpacing: 1.4,
                  fontWeight: 600,
                }}
              >
                Active Workspace
              </div>
              <div
                style={{
                  marginTop: 8,
                  fontSize: 19,
                  lineHeight: 1.15,
                  color: COLORS.text,
                  fontWeight: 600,
                  letterSpacing: -0.8,
                }}
              >
                {workspaceName}
              </div>
              <div
                style={{
                  marginTop: 5,
                  fontSize: 13,
                  color: COLORS.textSecondary,
                  lineHeight: 1.35,
                }}
              >
                {workspaceMeta}
              </div>
            </FrostPanel>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 12px',
                borderRadius: 16,
                border: `1px solid ${toRgba(COLORS.green, 0.3)}`,
                background: toRgba(COLORS.green, 0.12),
                color: COLORS.text,
              }}
            >
              <div
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: '50%',
                  background: COLORS.green,
                  boxShadow: `0 0 16px ${toRgba(COLORS.green, 0.5)}`,
                  flexShrink: 0,
                }}
              />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>Run</div>
                <div style={{ fontSize: 10, color: COLORS.textSecondary, marginTop: 2 }}>
                  `npm run dev` ready
                </div>
              </div>
              <div
                style={{
                  width: 0,
                  height: 0,
                  borderTop: '6px solid transparent',
                  borderBottom: '6px solid transparent',
                  borderLeft: `9px solid ${COLORS.green}`,
                }}
              />
            </div>

            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {NAV_ITEMS.map((item) => {
                const active = item.label === activeNav;
                const color = TONE_COLORS[item.tone];
                return (
                  <div
                    key={item.label}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '6px 8px',
                      borderRadius: 14,
                      border: `1px solid ${active ? toRgba(color, 0.28) : 'transparent'}`,
                      background: active ? toRgba(color, 0.12) : 'transparent',
                      color: active ? COLORS.text : COLORS.textSecondary,
                    }}
                  >
                    <SidebarBadge short={item.short} tone={item.tone} />
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: active ? 600 : 500,
                        letterSpacing: -0.2,
                      }}
                    >
                      {item.label}
                    </div>
                  </div>
                );
              })}
            </div>

            <FrostPanel style={{ padding: '10px 12px', borderRadius: 18 }}>
              {[
                { label: 'Foundry', tone: COLORS.green },
                { label: 'ADO', tone: COLORS.cyan },
                { label: 'Confluence', tone: COLORS.amber },
              ].map((item) => (
                <div
                  key={item.label}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      color: COLORS.textSecondary,
                      fontSize: 11,
                      marginBottom: item.label === 'Confluence' ? 0 : 6,
                    }}
                  >
                  <div
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: item.tone,
                      boxShadow: `0 0 14px ${toRgba(item.tone, 0.55)}`,
                    }}
                  />
                  {item.label}
                </div>
              ))}
            </FrostPanel>
          </div>

          <div
            style={{
              flex: 1,
              background: `linear-gradient(180deg, ${toRgba(COLORS.panel, 0.84)} 0%, ${toRgba(
                COLORS.bg,
                0.72,
              )} 100%)`,
              minWidth: 0,
            }}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
};

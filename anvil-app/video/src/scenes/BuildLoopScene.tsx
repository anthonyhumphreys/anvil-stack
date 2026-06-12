import React from 'react';
import { interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import {
  AppFrame,
  COLORS,
  FONTS,
  FrostPanel,
  MetricPill,
  ScreenBackground,
  SectionHeader,
  StatCard,
  stagger,
  toRgba,
} from './VideoSystem';

export const BuildLoopScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const chatReveal = stagger(frame, fps, 16);
  const runReveal = stagger(frame, fps, 28);
  const browserReveal = stagger(frame, fps, 38);

  const prompt = 'Scaffold the UI shell, run the app, and open the live preview.';
  const promptCount = Math.floor(
    interpolate(frame, [18, 74], [0, prompt.length], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    }),
  );
  const typedPrompt = prompt.slice(0, promptCount);

  return (
    <ScreenBackground accent={COLORS.cyan} secondary={COLORS.violet} ghostLabel="Iterate">
      <AppFrame activeNav="Browser">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1.03fr 0.97fr',
            gridTemplateRows: 'auto 1fr',
            gap: 22,
            height: '100%',
            padding: 30,
          }}
        >
          <div style={{ gridColumn: '1 / span 2', display: 'flex', justifyContent: 'space-between', gap: 20 }}>
            <SectionHeader
              kicker="Build Loop"
              accent={COLORS.cyan}
              title={
                <>
                  Prompt. Run. Inspect.
                  <br />
                  Iterate.
                </>
              }
              body="Codex-backed chat, sidebar run controls, dev-server detection, and the embedded browser keep the feedback loop in one place."
              width={900}
            />

            <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
              <StatCard label="Detected Targets" value="02" detail="Frontend + API" tone="cyan" style={{ width: 210 }} />
              <StatCard label="Bridge Status" value="Live" detail="CDP attached to the embedded browser" tone="green" style={{ width: 260 }} />
            </div>
          </div>

          <FrostPanel
            style={{
              padding: 0,
              overflow: 'hidden',
              opacity: chatReveal,
            }}
          >
            <div
              style={{
                padding: '18px 20px',
                borderBottom: `1px solid ${COLORS.lineSoft}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: toRgba(COLORS.panelRaised, 0.66),
              }}
            >
              <div>
                <div style={{ fontSize: 12, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 1.4, fontWeight: 600 }}>
                  Chat Session
                </div>
                <div style={{ marginTop: 8, fontSize: 24, color: COLORS.text, fontWeight: 700, letterSpacing: -0.9 }}>
                  Design Companion → Implement Mode
                </div>
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <MetricPill label="Coder" tone="green" />
                <MetricPill label="Design Companion" tone="violet" />
              </div>
            </div>

            <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div
                style={{
                  alignSelf: 'flex-end',
                  maxWidth: '82%',
                  padding: '16px 18px',
                  borderRadius: 24,
                  background: toRgba(COLORS.cyan, 0.14),
                  border: `1px solid ${toRgba(COLORS.cyan, 0.26)}`,
                  color: COLORS.text,
                  fontSize: 18,
                  lineHeight: 1.45,
                }}
              >
                {typedPrompt}
                <span style={{ opacity: Math.floor(frame / 8) % 2 === 0 ? 1 : 0, color: COLORS.cyan }}>|</span>
              </div>

              {[
                'Read scaffold root and existing AGENTS.md conventions',
                'Create repo structure and starter surfaces',
                'Trigger run commands and browser connection',
              ].map((label, index) => (
                <div
                  key={label}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    padding: '14px 16px',
                    borderRadius: 18,
                    border: `1px solid ${COLORS.lineSoft}`,
                    background: toRgba(COLORS.bgDeep, 0.6),
                    color: COLORS.textSecondary,
                  }}
                >
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 999,
                      background: index === 2 ? toRgba(COLORS.green, 0.18) : toRgba(COLORS.cyan, 0.14),
                      border: `1px solid ${toRgba(index === 2 ? COLORS.green : COLORS.cyan, 0.26)}`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: index === 2 ? COLORS.green : COLORS.cyan,
                      fontFamily: FONTS.mono,
                      fontSize: 12,
                      fontWeight: 700,
                    }}
                  >
                    0{index + 1}
                  </div>
                  <span style={{ fontSize: 17, color: COLORS.text }}>{label}</span>
                </div>
              ))}

              <div
                style={{
                  padding: 18,
                  borderRadius: 22,
                  background: toRgba(COLORS.green, 0.08),
                  border: `1px solid ${toRgba(COLORS.green, 0.2)}`,
                }}
              >
                <div style={{ fontSize: 14, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 1.2 }}>
                  Session Output
                </div>
                <div style={{ marginTop: 12, fontSize: 18, color: COLORS.text, lineHeight: 1.55 }}>
                  “Frontend scaffold created. `npm run dev` launched. Browser bridge attached to
                  `localhost:3000`.”
                </div>
              </div>
            </div>
          </FrostPanel>

          <div style={{ display: 'grid', gridTemplateRows: '0.73fr 1.27fr', gap: 22 }}>
            <FrostPanel
              style={{
                padding: 22,
                opacity: runReveal,
                borderColor: toRgba(COLORS.green, 0.22),
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: 12, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 1.4, fontWeight: 600 }}>
                    Run Button
                  </div>
                  <div style={{ marginTop: 10, fontSize: 26, color: COLORS.text, fontWeight: 700, letterSpacing: -1 }}>
                    Workspace scripts, grouped by repo
                  </div>
                </div>
                <MetricPill label="Running" tone="green" />
              </div>

              <div style={{ marginTop: 18, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                {[
                  {
                    repo: 'frontend',
                    commands: ['npm run dev', 'npm run build', 'npm run test'],
                  },
                  {
                    repo: 'api',
                    commands: ['npm run dev', 'npm run lint', 'npm run test'],
                  },
                ].map((group, groupIndex) => (
                  <div
                    key={group.repo}
                    style={{
                      padding: 16,
                      borderRadius: 20,
                      border: `1px solid ${COLORS.lineSoft}`,
                      background: toRgba(COLORS.panelSoft, 0.5),
                    }}
                  >
                    <div style={{ fontSize: 14, color: groupIndex === 0 ? COLORS.green : COLORS.cyan, fontWeight: 700 }}>
                      {group.repo}
                    </div>
                    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {group.commands.map((command, index) => (
                        <div
                          key={command}
                          style={{
                            padding: '11px 12px',
                            borderRadius: 14,
                            border: `1px solid ${toRgba(index === 0 ? COLORS.green : COLORS.lineSoft, index === 0 ? 0.32 : 0.4)}`,
                            background: index === 0 ? toRgba(COLORS.green, 0.12) : toRgba(COLORS.bgDeep, 0.42),
                            color: COLORS.text,
                            fontSize: 14,
                            fontFamily: FONTS.mono,
                          }}
                        >
                          {command}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </FrostPanel>

            <FrostPanel
              style={{
                padding: 0,
                overflow: 'hidden',
                opacity: browserReveal,
                borderColor: toRgba(COLORS.cyan, 0.22),
              }}
            >
              <div
                style={{
                  padding: '16px 18px',
                  borderBottom: `1px solid ${COLORS.lineSoft}`,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  background: toRgba(COLORS.panelRaised, 0.66),
                }}
              >
                <div>
                  <div style={{ fontSize: 12, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 1.4, fontWeight: 600 }}>
                    Embedded Browser
                  </div>
                  <div style={{ marginTop: 8, fontSize: 22, color: COLORS.text, fontWeight: 700, letterSpacing: -0.8 }}>
                    Dev servers, URL bar, and CDP bridge
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <MetricPill label="2 detected" tone="cyan" />
                  <MetricPill label="Bridge live" tone="green" />
                </div>
              </div>

              <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '14px 16px',
                    borderRadius: 18,
                    border: `1px solid ${COLORS.lineSoft}`,
                    background: toRgba(COLORS.bgDeep, 0.55),
                  }}
                >
                  <div
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 999,
                      background: toRgba(COLORS.cyan, 0.16),
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: COLORS.cyan,
                      fontFamily: FONTS.mono,
                      fontWeight: 700,
                    }}
                  >
                    URL
                  </div>
                  <div
                    style={{
                      flex: 1,
                      padding: '10px 12px',
                      borderRadius: 14,
                      border: `1px solid ${toRgba(COLORS.cyan, 0.22)}`,
                      background: toRgba(COLORS.panelSoft, 0.55),
                      fontSize: 14,
                      color: COLORS.text,
                      fontFamily: FONTS.mono,
                    }}
                  >
                    http://localhost:3000
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 16, minHeight: 270 }}>
                  <div
                    style={{
                      padding: 16,
                      borderRadius: 20,
                      border: `1px solid ${COLORS.lineSoft}`,
                      background: toRgba(COLORS.panelSoft, 0.52),
                    }}
                  >
                    <div style={{ fontSize: 14, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 1.2 }}>
                      Targets
                    </div>
                    <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {[
                        ['frontend dev server', 'localhost:3000'],
                        ['storybook preview', 'localhost:6006'],
                      ].map(([label, url], index) => (
                        <div
                          key={label}
                          style={{
                            padding: '12px 14px',
                            borderRadius: 16,
                            border: `1px solid ${toRgba(index === 0 ? COLORS.cyan : COLORS.lineSoft, index === 0 ? 0.26 : 0.42)}`,
                            background: index === 0 ? toRgba(COLORS.cyan, 0.1) : toRgba(COLORS.bgDeep, 0.48),
                          }}
                        >
                          <div style={{ fontSize: 15, color: COLORS.text, fontWeight: 600 }}>{label}</div>
                          <div style={{ marginTop: 6, fontSize: 12, color: COLORS.textSecondary, fontFamily: FONTS.mono }}>
                            {url}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div
                    style={{
                      padding: 18,
                      borderRadius: 22,
                      border: `1px solid ${COLORS.lineSoft}`,
                      background:
                        'linear-gradient(180deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.01) 100%)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 14,
                    }}
                  >
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1.4fr 0.9fr',
                        gap: 12,
                      }}
                    >
                      <div
                        style={{
                          padding: 18,
                          borderRadius: 18,
                          background: 'linear-gradient(135deg, rgba(67,208,255,0.18) 0%, rgba(138,125,255,0.12) 100%)',
                          minHeight: 178,
                        }}
                      >
                        <div style={{ fontSize: 13, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 1.2 }}>
                          Live page preview
                        </div>
                        <div style={{ marginTop: 18, fontSize: 32, color: COLORS.text, fontWeight: 700, letterSpacing: -1.3 }}>
                          Student Portal
                        </div>
                        <div style={{ marginTop: 12, width: '80%', fontSize: 16, color: COLORS.textSecondary, lineHeight: 1.5 }}>
                          Browser-assisted workflows can inspect, click, and validate the surface without leaving the app.
                        </div>
                      </div>

                      <div
                        style={{
                          padding: 18,
                          borderRadius: 18,
                          background: toRgba(COLORS.panelSoft, 0.6),
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 10,
                        }}
                      >
                        {['Layout stable', 'Bridge attached', 'Reload available'].map((item) => (
                          <div
                            key={item}
                            style={{
                              padding: '12px 12px',
                              borderRadius: 14,
                              background: toRgba(COLORS.bgDeep, 0.52),
                              color: COLORS.text,
                              fontSize: 14,
                              border: `1px solid ${COLORS.lineSoft}`,
                            }}
                          >
                            {item}
                          </div>
                        ))}
                      </div>
                    </div>

                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(4, 1fr)',
                        gap: 10,
                      }}
                    >
                      {['Accessibility checks', 'Console traces', 'Route smoke tests', 'Visual QA pass'].map((item) => (
                        <div
                          key={item}
                          style={{
                            padding: '12px 12px',
                            borderRadius: 14,
                            border: `1px solid ${COLORS.lineSoft}`,
                            background: toRgba(COLORS.bgDeep, 0.45),
                            color: COLORS.textSecondary,
                            fontSize: 13,
                            lineHeight: 1.35,
                          }}
                        >
                          {item}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </FrostPanel>
          </div>
        </div>
      </AppFrame>
    </ScreenBackground>
  );
};

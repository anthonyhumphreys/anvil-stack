import React from 'react';
import { interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import {
  COLORS,
  FONTS,
  FrostPanel,
  MetricPill,
  ScreenBackground,
  StatCard,
  SectionHeader,
  stagger,
  rise,
  toRgba,
} from './VideoSystem';

export const HeroScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const scriptLine = 'Run. Review. Pentest. Package the evidence.';
  const typedCount = Math.floor(
    interpolate(frame, [20, 88], [0, scriptLine.length], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    }),
  );
  const typedLine = scriptLine.slice(0, typedCount);
  const cursorVisible = Math.floor(frame / 8) % 2 === 0;

  const topCard = stagger(frame, fps, 16);
  const middleCard = stagger(frame, fps, 26);
  const bottomCard = stagger(frame, fps, 36);

  return (
    <ScreenBackground accent={COLORS.red} secondary={COLORS.cyan} ghostLabel="Mission">
      <div
        style={{
          display: 'flex',
          height: '100%',
          padding: '96px 108px',
          gap: 56,
          alignItems: 'center',
        }}
      >
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 28 }}>
          <SectionHeader
            kicker="Anvil / Delivery Mission Control"
            accent={COLORS.red}
            title={
              <>
                One workspace
                <br />
                for code, assurance,
                <br />
                and governance.
              </>
            }
            body="Anvil brings repo context, delivery tooling, security signal, and governance evidence into a single desktop surface."
            width={860}
          />

          <FrostPanel
            style={{
              padding: '18px 22px',
              maxWidth: 760,
              borderColor: toRgba(COLORS.cyan, 0.22),
            }}
          >
            <div
              style={{
                fontFamily: FONTS.mono,
                fontSize: 24,
                color: COLORS.text,
                lineHeight: 1.45,
                letterSpacing: -0.2,
              }}
            >
              {typedLine}
              <span style={{ opacity: cursorVisible ? 1 : 0, color: COLORS.cyan }}>|</span>
            </div>
            <div
              style={{
                marginTop: 10,
                fontSize: 15,
                color: COLORS.textSecondary,
              }}
            >
              Less tab choreography. More signal.
            </div>
          </FrostPanel>

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', maxWidth: 840 }}>
            <MetricPill label="Workspaces and scaffold flows" tone="amber" />
            <MetricPill label="Run + browser + live previews" tone="cyan" />
            <MetricPill label="Code review + Strix pentest" tone="red" />
            <MetricPill label="Lifecycle gates and handover packs" tone="green" />
          </div>
        </div>

        <div style={{ width: 740, height: 760, position: 'relative' }}>
          <FrostPanel
            style={{
              position: 'absolute',
              inset: '42px 26px auto 0',
              padding: 28,
              opacity: topCard,
              transform: `translateY(${interpolate(topCard, [0, 1], [30, 0])}px)`,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div>
                <div
                  style={{
                    fontSize: 12,
                    color: COLORS.textMuted,
                    textTransform: 'uppercase',
                    letterSpacing: 1.5,
                    fontWeight: 600,
                  }}
                >
                  Delivery Surface
                </div>
                <div
                  style={{
                    marginTop: 10,
                    fontSize: 30,
                    lineHeight: 1,
                    color: COLORS.text,
                    fontWeight: 700,
                    letterSpacing: -1.4,
                  }}
                >
                  North Star Platform
                </div>
              </div>
              <MetricPill label="Ready" tone="green" />
            </div>

            <div
              style={{
                marginTop: 24,
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 14,
              }}
            >
              <StatCard label="Repos" value="03" detail="Indexed and active" tone="cyan" />
              <StatCard label="Work Items" value="12" detail="ADO linked" tone="amber" />
              <StatCard label="Gate Status" value="2/4" detail="Green this week" tone="red" />
            </div>
          </FrostPanel>

          <FrostPanel
            style={{
              position: 'absolute',
              top: 300,
              left: 82,
              right: 0,
              padding: 24,
              opacity: middleCard,
              transform: `${rise(middleCard, 30)} rotate(-2deg)`,
              borderColor: toRgba(COLORS.cyan, 0.18),
            }}
          >
            <div
              style={{
                fontSize: 12,
                color: COLORS.textMuted,
                textTransform: 'uppercase',
                letterSpacing: 1.5,
                fontWeight: 600,
              }}
            >
              Connected Stack
            </div>
            <div
              style={{
                marginTop: 18,
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 12,
              }}
            >
              {[
                ['Codex', COLORS.cyan],
                ['ADO', COLORS.amber],
                ['Confluence', COLORS.violet],
                ['Docker', COLORS.green],
                ['Figma', COLORS.red],
                ['GitHub', COLORS.cyan],
              ].map(([label, color]) => (
                <div
                  key={label}
                  style={{
                    padding: '16px 14px',
                    borderRadius: 20,
                    border: `1px solid ${toRgba(color, 0.25)}`,
                    background: toRgba(color, 0.08),
                    color: COLORS.text,
                  }}
                >
                  <div
                    style={{
                      width: 11,
                      height: 11,
                      borderRadius: '50%',
                      background: color,
                      boxShadow: `0 0 18px ${toRgba(color, 0.55)}`,
                    }}
                  />
                  <div
                    style={{
                      marginTop: 16,
                      fontSize: 18,
                      fontWeight: 600,
                      letterSpacing: -0.5,
                    }}
                  >
                    {label}
                  </div>
                </div>
              ))}
            </div>
          </FrostPanel>

          <FrostPanel
            style={{
              position: 'absolute',
              left: 28,
              right: 72,
              bottom: 22,
              padding: 22,
              opacity: bottomCard,
              transform: `${rise(bottomCard, 30)} rotate(1deg)`,
              borderColor: toRgba(COLORS.red, 0.24),
            }}
          >
            <div
              style={{
                fontSize: 12,
                color: COLORS.textMuted,
                textTransform: 'uppercase',
                letterSpacing: 1.5,
                fontWeight: 600,
              }}
            >
              Value Loop
            </div>
            <div
              style={{
                marginTop: 18,
                display: 'flex',
                flexDirection: 'column',
                gap: 14,
              }}
            >
              {[
                'Prompt the change',
                'Run the stack',
                'Inspect the browser',
                'Review the risk',
                'Export the evidence',
              ].map((step, index) => (
                <div
                  key={step}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 16,
                    color: COLORS.text,
                  }}
                >
                  <div
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 999,
                      background: toRgba(index < 3 ? COLORS.cyan : COLORS.red, 0.14),
                      border: `1px solid ${toRgba(index < 3 ? COLORS.cyan : COLORS.red, 0.26)}`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: index < 3 ? COLORS.cyan : COLORS.red,
                      fontSize: 13,
                      fontFamily: FONTS.mono,
                      flexShrink: 0,
                    }}
                  >
                    0{index + 1}
                  </div>
                  <div style={{ fontSize: 19, fontWeight: 500, letterSpacing: -0.4 }}>{step}</div>
                </div>
              ))}
            </div>
          </FrostPanel>
        </div>
      </div>
    </ScreenBackground>
  );
};

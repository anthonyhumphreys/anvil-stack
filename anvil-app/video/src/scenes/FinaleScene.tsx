import React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import {
  COLORS,
  FrostPanel,
  MetricPill,
  ScreenBackground,
  SectionHeader,
  stagger,
  rise,
  toRgba,
} from './VideoSystem';

export const FinaleScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const panels = stagger(frame, fps, 20);
  const footer = stagger(frame, fps, 36);

  return (
    <ScreenBackground accent={COLORS.red} secondary={COLORS.cyan} ghostLabel="Anvil">
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          height: '100%',
          padding: '96px 104px 72px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 40 }}>
          <SectionHeader
            kicker="Closing Thesis"
            accent={COLORS.red}
            title={
              <>
                Build with context.
                <br />
                Ship with evidence.
                <br />
                Lead with confidence.
              </>
            }
            body="Anvil brings chat, run, browser, review, pentest, and governance into one operating surface for modern delivery teams."
            width={980}
          />

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start', marginTop: 8 }}>
            <MetricPill label="Built for developers" tone="cyan" />
            <MetricPill label="Legible to stakeholders" tone="amber" />
            <MetricPill label="Board-ready by default" tone="green" />
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 18,
            opacity: panels,
            transform: rise(panels, 26),
          }}
        >
          {[
            {
              title: 'For engineers',
              points: ['Repo context', 'Run controls', 'Embedded browser', 'Design implementation'],
              tone: COLORS.cyan,
            },
            {
              title: 'For delivery leads',
              points: ['Work-item traceability', 'Scoped reviews', 'Security evidence', 'Faster decision loops'],
              tone: COLORS.amber,
            },
            {
              title: 'For senior stakeholders',
              points: ['Impact analysis', 'Gate readiness', 'Governance docs', 'Handover packs'],
              tone: COLORS.red,
            },
          ].map((column) => (
            <FrostPanel
              key={column.title}
              style={{
                padding: 24,
                borderColor: toRgba(column.tone, 0.22),
              }}
            >
              <div style={{ fontSize: 14, color: column.tone, textTransform: 'uppercase', letterSpacing: 1.4, fontWeight: 700 }}>
                {column.title}
              </div>
              <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                {column.points.map((point) => (
                  <div
                    key={point}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      color: COLORS.text,
                    }}
                  >
                    <div
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: '50%',
                        background: column.tone,
                        boxShadow: `0 0 14px ${toRgba(column.tone, 0.55)}`,
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ fontSize: 18, letterSpacing: -0.4 }}>{point}</span>
                  </div>
                ))}
              </div>
            </FrostPanel>
          ))}
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            gap: 24,
            opacity: footer,
            transform: rise(footer, 16),
          }}
        >
          <div>
            <div style={{ fontSize: 64, color: COLORS.text, fontWeight: 700, letterSpacing: -2.8 }}>
              Anvil
            </div>
            <div style={{ marginTop: 10, fontSize: 20, color: COLORS.textSecondary, letterSpacing: -0.3 }}>
              The build loop and the board pack finally share a screen.
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              padding: '16px 18px',
              borderRadius: 22,
              border: `1px solid ${COLORS.line}`,
              background: toRgba(COLORS.panelRaised, 0.9),
            }}
          >
            <div>
              <div style={{ fontSize: 14, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 1.2 }}>
                anthonyhumphreys.dev
              </div>
              <div style={{ marginTop: 4, fontSize: 18, color: COLORS.text, fontWeight: 600 }}>
                @aphumphreys
              </div>
            </div>
          </div>
        </div>
      </div>
    </ScreenBackground>
  );
};

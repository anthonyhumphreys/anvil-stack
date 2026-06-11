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

export const ProductOutroScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const reveal = stagger(frame, fps, 20);

  return (
    <ScreenBackground accent={COLORS.red} secondary={COLORS.cyan} ghostLabel="Launch">
      <div
        style={{
          display: 'grid',
          gridTemplateRows: '1fr auto',
          height: '100%',
          padding: '94px 100px 70px',
          gap: 28,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 34 }}>
          <SectionHeader
            kicker="Close"
            title={
              <>
                Fewer tabs.
                <br />
                Faster decisions.
                <br />
                Sharper delivery.
              </>
            }
            body="Anvil gives engineers a slicker build loop and gives senior stakeholders cleaner evidence. The same surface serves both."
            accent={COLORS.red}
            width={920}
          />

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-end' }}>
            <MetricPill label="16 product surfaces on the rail" tone="red" />
            <MetricPill label="9 specialist personas" tone="cyan" />
            <MetricPill label="1 integrated desktop surface" tone="green" />
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 18,
            opacity: reveal,
            transform: rise(reveal, 18),
          }}
        >
          {[
            {
              title: 'For engineers',
              tone: COLORS.cyan,
              points: ['Run and inspect the app', 'Open the embedded IDE', 'Keep repo and DB context loaded'],
            },
            {
              title: 'For delivery leads',
              tone: COLORS.amber,
              points: ['Turn work into action', 'Automate the checks', 'Keep docs, ADRs, and diagrams close'],
            },
            {
              title: 'For senior stakeholders',
              tone: COLORS.red,
              points: ['See risk earlier', 'Track lifecycle evidence', 'Approve with mobile visibility'],
            },
          ].map((column) => (
            <FrostPanel
              key={column.title}
              style={{
                padding: 22,
                borderColor: toRgba(column.tone, 0.22),
              }}
            >
              <div style={{ fontSize: 14, color: column.tone, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.2 }}>
                {column.title}
              </div>
              <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                {column.points.map((point) => (
                  <div
                    key={point}
                    style={{
                      padding: '12px 14px',
                      borderRadius: 16,
                      background: toRgba(column.tone, 0.08),
                      border: `1px solid ${toRgba(column.tone, 0.2)}`,
                      color: COLORS.text,
                      fontSize: 17,
                      lineHeight: 1.35,
                    }}
                  >
                    {point}
                  </div>
                ))}
              </div>
            </FrostPanel>
          ))}
        </div>
      </div>
    </ScreenBackground>
  );
};

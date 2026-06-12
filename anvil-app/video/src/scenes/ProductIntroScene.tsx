import React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import {
  AppFrame,
  COLORS,
  FrostPanel,
  MetricPill,
  ScreenBackground,
  SectionHeader,
  StatCard,
  stagger,
  rise,
  toRgba,
} from './VideoSystem';

export const ProductIntroScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const panelReveal = stagger(frame, fps, 16);

  return (
    <ScreenBackground accent={COLORS.red} secondary={COLORS.cyan} ghostLabel="Anvil">
      <AppFrame activeNav="Repositories">
        <div
          style={{
            display: 'grid',
            gridTemplateRows: 'auto 1fr',
            gap: 22,
            height: '100%',
            padding: 28,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 28 }}>
            <SectionHeader
              kicker="Anvil"
              title={
                <>
                  AI delivery
                  <br />
                  mission control.
                </>
              }
              body="Repo context, Codex agents, embedded IDE, assurance, governance, automations, and mobile visibility in one desktop cockpit."
              accent={COLORS.red}
              width={900}
            />

            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <StatCard label="Product surfaces" value="16" detail="Every major delivery mode on the rail." tone="red" style={{ width: 220 }} />
              <StatCard label="Specialist personas" value="9" detail="Including Design Companion, BA, and DB Expert." tone="cyan" style={{ width: 220 }} />
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1.15fr 0.85fr',
              gap: 18,
              opacity: panelReveal,
              transform: rise(panelReveal, 22),
            }}
          >
            <FrostPanel style={{ padding: 22 }}>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, 1fr)',
                  gap: 14,
                }}
              >
                {[
                  {
                    label: 'Build Loop',
                    tone: COLORS.cyan,
                    items: ['Repositories', 'Codex Agent', 'Embedded IDE', 'Terminal'],
                  },
                  {
                    label: 'Delivery Loop',
                    tone: COLORS.amber,
                    items: ['Work Items', 'Browser', 'Git', 'Automations'],
                  },
                  {
                    label: 'Assurance Loop',
                    tone: COLORS.red,
                    items: ['Security', 'Code Review', 'Governance', 'Diagnostics'],
                  },
                ].map((group) => (
                  <div
                    key={group.label}
                    style={{
                      padding: 18,
                      borderRadius: 24,
                      border: `1px solid ${toRgba(group.tone, 0.24)}`,
                      background: toRgba(group.tone, 0.08),
                    }}
                  >
                    <div style={{ fontSize: 13, color: group.tone, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.2 }}>
                      {group.label}
                    </div>
                    <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {group.items.map((item) => (
                        <div key={item} style={{ color: COLORS.text, fontSize: 18, fontWeight: 600, letterSpacing: -0.4 }}>
                          {item}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: 18, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <MetricPill label="Run targets detected" tone="green" />
                <MetricPill label="Browser bridge live" tone="cyan" />
                <MetricPill label="DB Expert context ready" tone="amber" />
                <MetricPill label="Mobile companion connected" tone="violet" />
              </div>
            </FrostPanel>

            <FrostPanel style={{ padding: 22, borderColor: toRgba(COLORS.violet, 0.22) }}>
              <div style={{ fontSize: 12, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 1.4, fontWeight: 600 }}>
                Newest surface
              </div>
              <div style={{ marginTop: 14, fontSize: 34, color: COLORS.text, fontWeight: 700, lineHeight: 0.98, letterSpacing: -1.4 }}>
                DB Insights
              </div>
              <div style={{ marginTop: 14, fontSize: 17, color: COLORS.textSecondary, lineHeight: 1.45 }}>
                Import SSMS exports, analyse tables and stored procedures, then switch to chat with workspace-level database context already loaded.
              </div>
              <div style={{ marginTop: 18, display: 'grid', gap: 10 }}>
                {[
                  'Schema exports → analysed in-app',
                  'Stored procedures → summarised and queryable',
                  'DB Expert persona → grounded in the latest analysis',
                ].map((item, index) => (
                  <div
                    key={item}
                    style={{
                      padding: '12px 14px',
                      borderRadius: 16,
                      background: toRgba(index === 0 ? COLORS.violet : index === 1 ? COLORS.amber : COLORS.cyan, 0.1),
                      border: `1px solid ${toRgba(index === 0 ? COLORS.violet : index === 1 ? COLORS.amber : COLORS.cyan, 0.22)}`,
                      color: COLORS.text,
                      fontSize: 15,
                      lineHeight: 1.35,
                    }}
                  >
                    {item}
                  </div>
                ))}
              </div>
            </FrostPanel>
          </div>
        </div>
      </AppFrame>
    </ScreenBackground>
  );
};

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
  toRgba,
} from './VideoSystem';

export const GovernanceScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const boardReveal = stagger(frame, fps, 18);
  const detailReveal = stagger(frame, fps, 30);

  return (
    <ScreenBackground accent={COLORS.red} secondary={COLORS.green} ghostLabel="Gate">
      <AppFrame activeNav="Governance">
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 30, gap: 22 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 20 }}>
            <SectionHeader
              kicker="Delivery Lifecycle"
              accent={COLORS.red}
              title={
                <>
                  Delivery evidence,
                  <br />
                  ready for scrutiny.
                </>
              }
              body="Impact analysis, gate readiness, governance documents, and handover packs turn the app activity into board-ready artefacts."
              width={900}
            />

            <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
              <StatCard label="Lifecycle Items" value="08" detail="Across ideation, build, and run" tone="amber" style={{ width: 220 }} />
              <StatCard label="Gate 4" value="Ready" detail="Evidence assembled for Build → Run" tone="green" style={{ width: 220 }} />
            </div>
          </div>

          <FrostPanel style={{ padding: 0, overflow: 'hidden', flex: 1 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '16px 18px',
                borderBottom: `1px solid ${COLORS.lineSoft}`,
                background: toRgba(COLORS.panelRaised, 0.64),
              }}
            >
              {[
                { label: 'Boards & Docs', active: false },
                { label: 'Delivery Lifecycle', active: true },
                { label: 'Gate Config', active: false },
              ].map(({ label, active }) => (
                <div
                  key={label}
                  style={{
                    padding: '10px 14px',
                    borderRadius: 999,
                    border: `1px solid ${active ? toRgba(COLORS.red, 0.28) : 'transparent'}`,
                    background: active ? toRgba(COLORS.red, 0.12) : 'transparent',
                    color: active ? COLORS.text : COLORS.textSecondary,
                    fontSize: 14,
                    fontWeight: active ? 600 : 500,
                  }}
                >
                  {label}
                </div>
              ))}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', height: '100%' }}>
              <div
                style={{
                  borderRight: `1px solid ${COLORS.lineSoft}`,
                  padding: 18,
                  opacity: boardReveal,
                }}
              >
                <div style={{ fontSize: 12, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 600 }}>
                  Lifecycle Items
                </div>
                <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {[
                    ['Admissions API hardening', 'Build', COLORS.amber],
                    ['Student portal beta release', 'Run', COLORS.green],
                    ['Governance doc refresh', 'Discovery & Design', COLORS.cyan],
                    ['Identity integration uplift', 'Ideation', COLORS.violet],
                  ].map(([title, stage, color], index) => (
                    <div
                      key={title}
                      style={{
                        padding: '16px 16px',
                        borderRadius: 20,
                        border: `1px solid ${toRgba(index === 0 ? COLORS.red : color, index === 0 ? 0.28 : 0.2)}`,
                        background: index === 0 ? toRgba(COLORS.red, 0.12) : toRgba(color, 0.08),
                      }}
                    >
                      <div style={{ fontSize: 17, color: COLORS.text, fontWeight: 600, lineHeight: 1.3 }}>{title}</div>
                      <div style={{ marginTop: 8, fontSize: 13, color: COLORS.textSecondary }}>{stage}</div>
                    </div>
                  ))}
                </div>

                <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <MetricPill label="Board docs available as chat context" tone="violet" />
                  <MetricPill label="Gate templates customised per workspace" tone="amber" />
                </div>
              </div>

              <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 18, opacity: detailReveal }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: 12, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 600 }}>
                      Lifecycle Detail
                    </div>
                    <div style={{ marginTop: 8, fontSize: 30, color: COLORS.text, fontWeight: 700, letterSpacing: -1.2 }}>
                      Admissions API hardening
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <MetricPill label="Build" tone="amber" />
                    <MetricPill label="Major change" tone="red" />
                  </div>
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(4, 1fr)',
                    gap: 12,
                  }}
                >
                  {[
                    ['Ideation', COLORS.violet],
                    ['Discovery & Design', COLORS.cyan],
                    ['Build', COLORS.amber],
                    ['Run', COLORS.green],
                  ].map(([label, color], index) => (
                    <div
                      key={label}
                      style={{
                        padding: 16,
                        borderRadius: 20,
                        border: `1px solid ${toRgba(color, index === 2 ? 0.34 : 0.2)}`,
                        background: toRgba(color, index === 2 ? 0.14 : 0.08),
                      }}
                    >
                      <div
                        style={{
                          width: 12,
                          height: 12,
                          borderRadius: '50%',
                          background: color,
                          boxShadow: `0 0 16px ${toRgba(color, 0.55)}`,
                        }}
                      />
                      <div style={{ marginTop: 18, fontSize: 17, color: COLORS.text, fontWeight: 600, lineHeight: 1.25 }}>
                        {label}
                      </div>
                    </div>
                  ))}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1.18fr 0.82fr', gap: 16 }}>
                  <FrostPanel
                    style={{
                      padding: 20,
                      borderColor: toRgba(COLORS.cyan, 0.2),
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ fontSize: 12, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 600 }}>
                        Impact Analysis
                      </div>
                      <MetricPill label="Medium risk" tone="amber" />
                    </div>
                    <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                      <StatCard label="Repos Linked" value="03" detail="API, portal, docs" tone="cyan" />
                      <StatCard label="Dependencies" value="07" detail="Cross-service impacts tracked" tone="amber" />
                      <StatCard label="Decision Pack" value="Ready" detail="Executive summary plus technical appendix" tone="green" />
                    </div>
                  </FrostPanel>

                  <FrostPanel
                    style={{
                      padding: 20,
                      borderColor: toRgba(COLORS.green, 0.22),
                    }}
                  >
                    <div style={{ fontSize: 12, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 600 }}>
                      Gate Readiness
                    </div>
                    <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {[
                        ['Security audit', COLORS.green],
                        ['Code review', COLORS.green],
                        ['ADR exists', COLORS.amber],
                        ['Handover pack', COLORS.green],
                      ].map(([label, color]) => (
                        <div
                          key={label}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '12px 14px',
                            borderRadius: 16,
                            border: `1px solid ${toRgba(color, 0.22)}`,
                            background: toRgba(color, 0.08),
                            color: COLORS.text,
                          }}
                        >
                          <span style={{ fontSize: 15 }}>{label}</span>
                          <div
                            style={{
                              width: 12,
                              height: 12,
                              borderRadius: '50%',
                              background: color,
                              boxShadow: `0 0 14px ${toRgba(color, 0.55)}`,
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  </FrostPanel>
                </div>

                <FrostPanel
                  style={{
                    padding: 20,
                    borderColor: toRgba(COLORS.red, 0.22),
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: 12, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 600 }}>
                        Handover Pack
                      </div>
                      <div style={{ marginTop: 8, fontSize: 24, color: COLORS.text, fontWeight: 700, letterSpacing: -1 }}>
                        Build to Run evidence bundle
                      </div>
                    </div>
                    <MetricPill label="ZIP generated" tone="green" />
                  </div>

                  <div style={{ marginTop: 18, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
                    {[
                      'Architecture summary',
                      'Impact analysis',
                      'Code review summary',
                      'Gate decisions',
                    ].map((item) => (
                      <div
                        key={item}
                        style={{
                          padding: '14px 16px',
                          borderRadius: 18,
                          border: `1px solid ${COLORS.lineSoft}`,
                          background: toRgba(COLORS.panelSoft, 0.46),
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
          </FrostPanel>
        </div>
      </AppFrame>
    </ScreenBackground>
  );
};

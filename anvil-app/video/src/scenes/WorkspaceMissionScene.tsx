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

export const WorkspaceMissionScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const leftPanel = stagger(frame, fps, 18);
  const rightTop = stagger(frame, fps, 28);
  const rightBottom = stagger(frame, fps, 38);

  return (
    <ScreenBackground accent={COLORS.amber} secondary={COLORS.cyan} ghostLabel="Workspace">
      <AppFrame activeNav="Repositories">
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 30, gap: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24 }}>
            <SectionHeader
              kicker="Workspace Setup"
              accent={COLORS.amber}
              title={
                <>
                  Connect existing repos
                  <br />
                  or scaffold new ones.
                </>
              }
              body="Anvil treats workspace creation as a delivery choice: start empty, connect local or remote repos, or scaffold new projects through the coder persona."
              width={920}
            />

            <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
              <StatCard label="Setup Paths" value="03" detail="Empty, connect, scaffold" tone="amber" style={{ width: 210 }} />
              <StatCard label="Remote Sources" value="GitHub + ADO" detail="Clone directly into the workspace" tone="cyan" style={{ width: 250 }} />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1.26fr 0.94fr', gap: 22, flex: 1 }}>
            <FrostPanel
              style={{
                padding: 24,
                display: 'flex',
                flexDirection: 'column',
                gap: 20,
                opacity: leftPanel,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
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
                    Create Workspace
                  </div>
                  <div
                    style={{
                      marginTop: 10,
                      fontSize: 28,
                      color: COLORS.text,
                      fontWeight: 700,
                      letterSpacing: -1.2,
                    }}
                  >
                    Choose the path that matches the delivery moment.
                  </div>
                </div>
                <MetricPill label="Scaffold complete marker detected" tone="green" />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
                {[
                  {
                    title: 'Empty workspace',
                    copy: 'Stand up the delivery shell now. Add repositories later.',
                    tone: COLORS.violet,
                  },
                  {
                    title: 'Connect repos',
                    copy: 'Bring in local folders or clone from GitHub and Azure DevOps.',
                    tone: COLORS.cyan,
                  },
                  {
                    title: 'Scaffold new repos',
                    copy: 'Start a workspace-first build flow rooted in a parent folder.',
                    tone: COLORS.amber,
                  },
                ].map((item, index) => (
                  <div
                    key={item.title}
                    style={{
                      padding: 18,
                      borderRadius: 24,
                      border: `1px solid ${toRgba(item.tone, index === 2 ? 0.38 : 0.2)}`,
                      background: toRgba(item.tone, index === 2 ? 0.14 : 0.08),
                      minHeight: 186,
                    }}
                  >
                    <div
                      style={{
                        width: 38,
                        height: 38,
                        borderRadius: 12,
                        background: toRgba(item.tone, 0.22),
                        border: `1px solid ${toRgba(item.tone, 0.36)}`,
                      }}
                    />
                    <div
                      style={{
                        marginTop: 18,
                        fontSize: 22,
                        color: COLORS.text,
                        fontWeight: 600,
                        letterSpacing: -0.6,
                        lineHeight: 1.05,
                      }}
                    >
                      {item.title}
                    </div>
                    <div
                      style={{
                        marginTop: 12,
                        fontSize: 15,
                        color: COLORS.textSecondary,
                        lineHeight: 1.5,
                      }}
                    >
                      {item.copy}
                    </div>
                  </div>
                ))}
              </div>

              <div>
                <div
                  style={{
                    fontSize: 12,
                    color: COLORS.textMuted,
                    textTransform: 'uppercase',
                    letterSpacing: 1.5,
                    fontWeight: 600,
                    marginBottom: 12,
                  }}
                >
                  Workspace Repositories
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {[
                    {
                      name: 'anvil-electron',
                      meta: 'Indexed · main · 145 modules summarised',
                      tags: ['Electron', 'React', 'TypeScript'],
                    },
                    {
                      name: 'north-star-api',
                      meta: 'Remote clone · indexing finished 2m ago',
                      tags: ['Node', 'ADO', 'REST'],
                    },
                    {
                      name: 'student-portal-web',
                      meta: 'Scaffolded via coder persona · dev server ready',
                      tags: ['Next.js', 'Browser', 'Run'],
                    },
                  ].map((repo) => (
                    <div
                      key={repo.name}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 16,
                        padding: '16px 18px',
                        borderRadius: 22,
                        border: `1px solid ${COLORS.lineSoft}`,
                        background: toRgba(COLORS.panelSoft, 0.6),
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
                        <div
                          style={{
                            fontSize: 19,
                            color: COLORS.text,
                            fontWeight: 600,
                            letterSpacing: -0.4,
                          }}
                        >
                          {repo.name}
                        </div>
                        <div
                          style={{
                            marginTop: 6,
                            fontSize: 14,
                            color: COLORS.textSecondary,
                          }}
                        >
                          {repo.meta}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        {repo.tags.map((tag) => (
                          <div
                            key={tag}
                            style={{
                              padding: '8px 10px',
                              borderRadius: 999,
                              border: `1px solid ${COLORS.lineSoft}`,
                              background: toRgba(COLORS.bgDeep, 0.6),
                              fontSize: 12,
                              color: COLORS.textSecondary,
                              fontWeight: 500,
                            }}
                          >
                            {tag}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </FrostPanel>

            <div style={{ display: 'grid', gridTemplateRows: '0.94fr 1.06fr', gap: 22 }}>
              <FrostPanel
                style={{
                  padding: 22,
                  opacity: rightTop,
                  borderColor: toRgba(COLORS.cyan, 0.22),
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
                  Readiness Signal
                </div>
                <div
                  style={{
                    marginTop: 16,
                    display: 'grid',
                    gridTemplateColumns: 'repeat(2, 1fr)',
                    gap: 12,
                  }}
                >
                  <StatCard label="Connector Health" value="100%" detail="Foundry, ADO, Confluence online" tone="green" />
                  <StatCard label="Repo Feature State" value="Ready" detail="Repo-dependent areas unlocked" tone="cyan" />
                </div>
                <div
                  style={{
                    marginTop: 18,
                    padding: 18,
                    borderRadius: 20,
                    background: toRgba(COLORS.bgDeep, 0.68),
                    border: `1px solid ${COLORS.lineSoft}`,
                  }}
                >
                  <div style={{ fontSize: 15, color: COLORS.textSecondary, lineHeight: 1.55 }}>
                    Empty, scaffolding, and indexing states remain visible with guidance, so users always know
                    what is unlocked next.
                  </div>
                </div>
              </FrostPanel>

              <FrostPanel
                style={{
                  padding: 22,
                  opacity: rightBottom,
                  borderColor: toRgba(COLORS.red, 0.22),
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
                  Persona Surface
                </div>
                <div
                  style={{
                    marginTop: 16,
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 10,
                  }}
                >
                  {[
                    ['Coder', COLORS.green],
                    ['Architect', COLORS.cyan],
                    ['Security', COLORS.red],
                    ['Code Reviewer', COLORS.amber],
                    ['Design Companion', COLORS.violet],
                    ['Business Analyst', COLORS.red],
                  ].map(([label, color]) => (
                    <div
                      key={label}
                      style={{
                        padding: '10px 12px',
                        borderRadius: 999,
                        border: `1px solid ${toRgba(color, 0.28)}`,
                        background: toRgba(color, 0.12),
                        color: COLORS.text,
                        fontSize: 13,
                        fontWeight: 600,
                      }}
                    >
                      {label}
                    </div>
                  ))}
                </div>

                <div
                  style={{
                    marginTop: 18,
                    display: 'grid',
                    gridTemplateColumns: 'repeat(2, 1fr)',
                    gap: 12,
                  }}
                >
                  <div
                    style={{
                      padding: 16,
                      borderRadius: 20,
                      background: toRgba(COLORS.panelSoft, 0.6),
                      border: `1px solid ${COLORS.lineSoft}`,
                    }}
                  >
                    <div style={{ fontSize: 14, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 1.1 }}>
                      Design
                    </div>
                    <div style={{ marginTop: 10, fontSize: 18, color: COLORS.text, fontWeight: 600 }}>
                      Figma-linked context
                    </div>
                    <div style={{ marginTop: 8, fontSize: 14, color: COLORS.textSecondary, lineHeight: 1.45 }}>
                      Designers stay in design mode. Developers switch to implementation mode.
                    </div>
                  </div>

                  <div
                    style={{
                      padding: 16,
                      borderRadius: 20,
                      background: toRgba(COLORS.panelSoft, 0.6),
                      border: `1px solid ${COLORS.lineSoft}`,
                    }}
                  >
                    <div style={{ fontSize: 14, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 1.1 }}>
                      Delivery
                    </div>
                    <div style={{ marginTop: 10, fontSize: 18, color: COLORS.text, fontWeight: 600 }}>
                      Work-item aware flows
                    </div>
                    <div style={{ marginTop: 8, fontSize: 14, color: COLORS.textSecondary, lineHeight: 1.45 }}>
                      BA sessions, review findings, and security issues can all become actionable work.
                    </div>
                  </div>
                </div>
              </FrostPanel>
            </div>
          </div>
        </div>
      </AppFrame>
    </ScreenBackground>
  );
};

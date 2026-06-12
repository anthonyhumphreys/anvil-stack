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

export const AssuranceScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const reviewReveal = stagger(frame, fps, 18);
  const pentestReveal = stagger(frame, fps, 30);
  const bottomReveal = stagger(frame, fps, 42);

  return (
    <ScreenBackground accent={COLORS.red} secondary={COLORS.cyan} ghostLabel="Prove">
      <AppFrame activeNav="Code Review">
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 30, gap: 22 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 22 }}>
            <SectionHeader
              kicker="Assurance Loop"
              accent={COLORS.red}
              title={
                <>
                  Review depth and exploit proof
                  <br />
                  in the same loop.
                </>
              }
              body="Anvil combines scoped PR reviews, static audit context, and Strix-powered dynamic pentests so teams can move from suspicion to evidence quickly."
              width={960}
            />

            <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
              <StatCard label="Scoped Review" value="PR #184" detail="Pull-request context selected" tone="cyan" style={{ width: 220 }} />
              <StatCard label="PoC Findings" value="03" detail="Dynamic exploits reproduced" tone="red" style={{ width: 220 }} />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 22, flex: 1 }}>
            <FrostPanel
              style={{
                padding: 24,
                opacity: reviewReveal,
                borderColor: toRgba(COLORS.cyan, 0.22),
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 18 }}>
                <div>
                  <div style={{ fontSize: 12, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 600 }}>
                    Code Review
                  </div>
                  <div style={{ marginTop: 10, fontSize: 28, color: COLORS.text, fontWeight: 700, letterSpacing: -1.1 }}>
                    Scope the check to the change that matters.
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <MetricPill label="Quick Glance" tone="cyan" />
                  <MetricPill label="Senior Dev" tone="amber" />
                </div>
              </div>

              <div style={{ marginTop: 18, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                <StatCard label="Scope" value="Pull Request" detail="Recent PR selected" tone="cyan" />
                <StatCard label="Findings" value="07" detail="2 high · 3 medium · 2 low" tone="amber" />
                <StatCard label="Mode" value="Senior Dev" detail="Depth over speed" tone="green" />
              </div>

              <div
                style={{
                  marginTop: 18,
                  padding: 18,
                  borderRadius: 22,
                  border: `1px solid ${COLORS.lineSoft}`,
                  background: toRgba(COLORS.bgDeep, 0.55),
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, color: COLORS.textMuted }}>
                  <span>Scope selector</span>
                  <span>Recent Pull Requests</span>
                </div>
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {[
                    ['PR #184', 'Open in Anvil launch flow links straight to the right review context.'],
                    ['Quick Glance', 'Fast triage pass for the team stand-up.'],
                    ['Senior Dev', 'Deeper read for bug risk, missing tests, and regressions.'],
                  ].map(([label, detail], index) => (
                    <div
                      key={label}
                      style={{
                        padding: '14px 16px',
                        borderRadius: 18,
                        border: `1px solid ${toRgba(index === 0 ? COLORS.cyan : COLORS.lineSoft, index === 0 ? 0.28 : 0.4)}`,
                        background: index === 0 ? toRgba(COLORS.cyan, 0.1) : toRgba(COLORS.panelSoft, 0.44),
                      }}
                    >
                      <div style={{ fontSize: 17, color: COLORS.text, fontWeight: 600 }}>{label}</div>
                      <div style={{ marginTop: 8, fontSize: 14, color: COLORS.textSecondary, lineHeight: 1.45 }}>
                        {detail}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {[
                  ['High', 'Null auth edge case in reviewer path can skip guardrail checks.'],
                  ['Medium', 'Diff parser misses renamed files in multi-commit PRs.'],
                  ['Low', 'Scope summary could surface missing docs more explicitly.'],
                ].map(([severity, text], index) => (
                  <div
                    key={text}
                    style={{
                      display: 'flex',
                      gap: 14,
                      padding: '14px 16px',
                      borderRadius: 18,
                      border: `1px solid ${COLORS.lineSoft}`,
                      background: toRgba(COLORS.panelSoft, 0.48),
                    }}
                  >
                    <div
                      style={{
                        minWidth: 72,
                        padding: '8px 10px',
                        borderRadius: 999,
                        border: `1px solid ${toRgba(index === 0 ? COLORS.red : index === 1 ? COLORS.amber : COLORS.cyan, 0.28)}`,
                        background: toRgba(index === 0 ? COLORS.red : index === 1 ? COLORS.amber : COLORS.cyan, 0.1),
                        color: index === 0 ? COLORS.red : index === 1 ? COLORS.amber : COLORS.cyan,
                        fontSize: 12,
                        fontWeight: 700,
                        textAlign: 'center',
                        textTransform: 'uppercase',
                      }}
                    >
                      {severity}
                    </div>
                    <div style={{ fontSize: 15, color: COLORS.text, lineHeight: 1.45 }}>{text}</div>
                  </div>
                ))}
              </div>
            </FrostPanel>

            <FrostPanel
              style={{
                padding: 24,
                opacity: pentestReveal,
                borderColor: toRgba(COLORS.red, 0.22),
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 18 }}>
                <div>
                  <div style={{ fontSize: 12, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 600 }}>
                    Strix Pentest
                  </div>
                  <div style={{ marginTop: 10, fontSize: 28, color: COLORS.text, fontWeight: 700, letterSpacing: -1.1 }}>
                    Move from static suspicion to dynamic proof.
                  </div>
                </div>
                <MetricPill label="Docker ready" tone="green" />
              </div>

              <div style={{ marginTop: 18, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                <StatCard label="Target" value="localhost" detail="Embedded browser checked first" tone="cyan" />
                <StatCard label="Categories" value="05" detail="Auth, IDOR, headers, secrets, SSRF" tone="amber" />
                <StatCard label="Work Items" value="03" detail="Bulk create available" tone="red" />
              </div>

              <div
                style={{
                  marginTop: 18,
                  padding: 18,
                  borderRadius: 22,
                  border: `1px solid ${COLORS.lineSoft}`,
                  background: toRgba(COLORS.bgDeep, 0.58),
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: 14, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 1.2 }}>
                    Live scan event stream
                  </div>
                  <MetricPill label="Running" tone="red" />
                </div>
                <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {[
                    'Spawning Docker container and attaching stdout stream',
                    'Targeting authenticated flow at http://localhost:3000',
                    'Confirmed exploit path: insecure direct object reference',
                    'Preparing PoC details and remediation payload for work item creation',
                  ].map((line, index) => (
                    <div
                      key={line}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        color: COLORS.textSecondary,
                        fontSize: 15,
                      }}
                    >
                      <div
                        style={{
                          width: 9,
                          height: 9,
                          borderRadius: '50%',
                          background: index < 2 ? COLORS.cyan : COLORS.red,
                          boxShadow: `0 0 14px ${toRgba(index < 2 ? COLORS.cyan : COLORS.red, 0.55)}`,
                          flexShrink: 0,
                        }}
                      />
                      {line}
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ marginTop: 18, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                {[
                  ['High', 'IDOR on transcript export endpoint', 'Create work item'],
                  ['Medium', 'Debug headers expose framework fingerprint', 'Queue for sprint'],
                ].map(([severity, title, cta], index) => (
                  <div
                    key={title}
                    style={{
                      padding: 18,
                      borderRadius: 22,
                      border: `1px solid ${toRgba(index === 0 ? COLORS.red : COLORS.amber, 0.26)}`,
                      background: toRgba(index === 0 ? COLORS.red : COLORS.amber, 0.08),
                    }}
                  >
                    <div
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        padding: '8px 10px',
                        borderRadius: 999,
                        background: toRgba(index === 0 ? COLORS.red : COLORS.amber, 0.14),
                        color: index === 0 ? COLORS.red : COLORS.amber,
                        fontSize: 12,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                      }}
                    >
                      {severity}
                    </div>
                    <div style={{ marginTop: 14, fontSize: 18, color: COLORS.text, fontWeight: 600, lineHeight: 1.3 }}>
                      {title}
                    </div>
                    <div style={{ marginTop: 12, fontSize: 14, color: COLORS.textSecondary, lineHeight: 1.45 }}>
                      Reproduction steps, payload, and PoC response captured for handoff.
                    </div>
                    <div
                      style={{
                        marginTop: 16,
                        display: 'inline-flex',
                        alignItems: 'center',
                        padding: '10px 12px',
                        borderRadius: 14,
                        border: `1px solid ${toRgba(COLORS.text, 0.08)}`,
                        background: toRgba(COLORS.bgDeep, 0.4),
                        color: COLORS.text,
                        fontSize: 13,
                        fontWeight: 600,
                      }}
                    >
                      {cta}
                    </div>
                  </div>
                ))}
              </div>
            </FrostPanel>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: 14,
              opacity: bottomReveal,
            }}
          >
            <StatCard label="Static + Dynamic" value="Both" detail="Static audit breadth with dynamic proof on top." tone="cyan" />
            <StatCard label="Traceability" value="Findings → Work" detail="Security and review issues can become tracked delivery items." tone="green" />
            <StatCard label="Signal Quality" value="Higher" detail="Teams see exploitability and engineering quality in one pass." tone="red" />
          </div>
        </div>
      </AppFrame>
    </ScreenBackground>
  );
};

import React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import {
  AppFrame,
  COLORS,
  type Tone,
  FrostPanel,
  MetricPill,
  ScreenBackground,
  SectionHeader,
  stagger,
  rise,
  toRgba,
} from './VideoSystem';

type SlideCard = {
  kicker: string;
  title: string;
  detail: string;
  tone: Tone;
};

export type FeatureSlideConfig = {
  activeNav: string;
  eyebrow: string;
  title: string;
  body: string;
  ghostLabel: string;
  accentTone: Tone;
  secondaryTone: Tone;
  pills: Array<{ label: string; tone: Tone }>;
  cards: SlideCard[];
  footerNotes: string[];
};

const TONE_MAP: Record<Tone, string> = {
  red: COLORS.red,
  cyan: COLORS.cyan,
  amber: COLORS.amber,
  green: COLORS.green,
  violet: COLORS.violet,
};

export const FeatureSlide: React.FC<FeatureSlideConfig> = ({
  activeNav,
  eyebrow,
  title,
  body,
  ghostLabel,
  accentTone,
  secondaryTone,
  pills,
  cards,
  footerNotes,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const cardReveal = stagger(frame, fps, 14);
  const accent = TONE_MAP[accentTone];
  const secondary = TONE_MAP[secondaryTone];
  const visibleCards = cards.slice(0, 3);

  return (
    <ScreenBackground accent={accent} secondary={secondary} ghostLabel={ghostLabel}>
      <AppFrame activeNav={activeNav}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 24,
            height: '100%',
            padding: 28,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24, alignItems: 'flex-start' }}>
            <SectionHeader
              kicker={eyebrow}
              title={title}
              body={body}
              accent={accent}
              width={920}
            />

            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                alignItems: 'flex-end',
                maxWidth: 360,
              }}
            >
              {pills.map((pill) => (
                <MetricPill key={pill.label} label={pill.label} tone={pill.tone} />
              ))}
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
              gap: 16,
              opacity: cardReveal,
              transform: rise(cardReveal, 22),
              flex: 1,
            }}
          >
            {visibleCards.map((card, index) => {
              const color = TONE_MAP[card.tone];
              const itemReveal = stagger(frame, fps, 16 + index * 4);

              return (
                <FrostPanel
                  key={`${card.kicker}-${card.title}`}
                  style={{
                    padding: 22,
                    minHeight: 236,
                    borderColor: toRgba(color, 0.24),
                    opacity: itemReveal,
                    transform: rise(itemReveal, 20),
                  }}
                >
                  <div
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '8px 10px',
                      borderRadius: 999,
                      background: toRgba(color, 0.12),
                      border: `1px solid ${toRgba(color, 0.24)}`,
                      color: color,
                      fontSize: 11,
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      letterSpacing: 1.2,
                    }}
                  >
                    <div
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: color,
                        boxShadow: `0 0 14px ${toRgba(color, 0.55)}`,
                      }}
                    />
                    {card.kicker}
                  </div>

                  <div
                    style={{
                      marginTop: 18,
                      fontSize: 38,
                      lineHeight: 0.98,
                      fontWeight: 700,
                      color: COLORS.text,
                      letterSpacing: -1.5,
                      maxWidth: '88%',
                    }}
                  >
                    {card.title}
                  </div>

                  <div
                    style={{
                      marginTop: 14,
                      fontSize: 15,
                      lineHeight: 1.4,
                      color: COLORS.textSecondary,
                      maxWidth: '88%',
                    }}
                  >
                    {card.detail}
                  </div>
                </FrostPanel>
              );
            })}
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: 12,
              opacity: cardReveal,
              transform: rise(cardReveal, 12),
            }}
          >
            {footerNotes.map((note, index) => (
              <div
                key={note}
                style={{
                  padding: '12px 16px',
                  borderRadius: 16,
                  border: `1px solid ${toRgba(index === 0 ? accent : index === 1 ? secondary : COLORS.green, 0.2)}`,
                  background: toRgba(index === 0 ? accent : index === 1 ? secondary : COLORS.green, 0.08),
                  color: COLORS.textSecondary,
                  fontSize: 15,
                  lineHeight: 1.35,
                }}
              >
                {note}
              </div>
            ))}
          </div>
        </div>
      </AppFrame>
    </ScreenBackground>
  );
};

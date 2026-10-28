import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { loadFont } from '@remotion/google-fonts/IBMPlexSans';
import { MezairMark } from './components/MezairMark';

const { fontFamily } = loadFont('normal', { weights: ['400', '600', '700'], subsets: ['latin'] });
export const MEZAIR_LOGO_SPLASH_DURATION = 120;

export const MezairLogoSplash: React.FC = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [18, 42], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <AbsoluteFill
      style={{
        background: '#171717',
        color: '#f8f7f4',
        justifyContent: 'center',
        alignItems: 'center',
        fontFamily,
      }}
    >
      <MezairMark size={390} />
      <div
        style={{
          marginTop: 32,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 18,
          opacity,
        }}
      >
        <div style={{ fontSize: 82, fontWeight: 700, letterSpacing: '-0.03em', lineHeight: 1 }}>
          mezair
        </div>
        <div
          style={{
            color: '#c7c6c2',
            fontSize: 22,
            fontFamily: 'ui-monospace, monospace',
            letterSpacing: '0.08em',
          }}
        >
          may-ZAIR
        </div>
      </div>
    </AbsoluteFill>
  );
};

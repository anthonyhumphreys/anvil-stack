import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { loadFont } from '@remotion/google-fonts/IBMPlexSans';
import { AnvilCrest } from './components/AnvilCrest';

const { fontFamily } = loadFont('normal', {
  weights: ['400', '600', '700'],
  subsets: ['latin'],
});

export const ANVIL_LOGO_SPLASH_DURATION = 120;

export const AnvilLogoSplash: React.FC = () => {
  const frame = useCurrentFrame();
  const titleOpacity = interpolate(frame, [24, 50], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const titleY = interpolate(frame, [24, 50], [20, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const gridOpacity = interpolate(frame, [0, 45], [0, 0.45], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        background:
          'linear-gradient(135deg, rgba(255,64,42,0.16), transparent 30%), linear-gradient(225deg, rgba(94,200,255,0.18), transparent 32%), #07101d',
        justifyContent: 'center',
        alignItems: 'center',
        fontFamily,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.045) 1px, transparent 1px)',
          backgroundSize: '84px 84px',
          opacity: gridOpacity,
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: 760,
          height: 760,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(94,200,255,0.18), transparent 68%)',
          filter: 'blur(4px)',
        }}
      />
      <AnvilCrest size={390} />
      <div
        style={{
          marginTop: 10,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 10,
          opacity: titleOpacity,
          transform: `translateY(${titleY}px)`,
        }}
      >
        <div style={{ color: 'white', fontSize: 82, fontWeight: 700, lineHeight: 1 }}>Anvil</div>
        <div
          style={{
            color: '#b8c7da',
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: 5,
            textTransform: 'uppercase',
          }}
        >
          Developer mission control
        </div>
      </div>
    </AbsoluteFill>
  );
};

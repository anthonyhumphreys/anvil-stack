import React from 'react';
import { Img, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';

interface MezairMarkProps {
  size?: number;
  animated?: boolean;
}

export const MezairMark: React.FC<MezairMarkProps> = ({ size = 360, animated = true }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = animated ? spring({ frame, fps, config: { damping: 20, stiffness: 100 } }) : 1;
  return (
    <Img
      src={staticFile('mezair-mark.svg')}
      width={size}
      height={Math.round((size * 800) / 1216)}
      style={{
        opacity: progress,
        transform: `translateY(${(1 - progress) * 18}px)`,
        filter: 'brightness(0) invert(1)',
      }}
    />
  );
};

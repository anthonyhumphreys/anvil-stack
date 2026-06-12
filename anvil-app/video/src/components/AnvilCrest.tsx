import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

interface AnvilCrestProps {
  size?: number;
  animated?: boolean;
}

export const AnvilCrest: React.FC<AnvilCrestProps> = ({ size = 360, animated = true }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const intro = animated ? spring({ frame, fps, config: { damping: 13, stiffness: 120 } }) : 1;
  const scan = animated ? interpolate(frame % 90, [0, 90], [-70, 280]) : 150;
  const pulse = animated ? interpolate(frame % 60, [0, 30, 60], [0.65, 1, 0.65]) : 0.8;
  const draw = animated ? interpolate(frame, [10, 34], [0, 1], { extrapolateRight: 'clamp' }) : 1;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      style={{
        overflow: 'visible',
        transform: `scale(${interpolate(intro, [0, 1], [0.72, 1])})`,
        opacity: intro,
        filter: `drop-shadow(0 0 ${20 + pulse * 26}px rgba(94, 200, 255, ${0.2 + pulse * 0.25}))`,
      }}
    >
      <defs>
        <linearGradient id="remotionShield" x1="38" x2="218" y1="24" y2="232">
          <stop stopColor="#f9fbff" />
          <stop offset=".32" stopColor="#7d8aa0" />
          <stop offset=".58" stopColor="#f4f8ff" />
          <stop offset="1" stopColor="#5f6a7b" />
        </linearGradient>
        <linearGradient id="remotionRed" x1="58" x2="198" y1="40" y2="112">
          <stop stopColor="#300507" />
          <stop offset=".55" stopColor="#a91118" />
          <stop offset="1" stopColor="#22040a" />
        </linearGradient>
        <linearGradient id="remotionBlue" x1="58" x2="198" y1="145" y2="225">
          <stop stopColor="#051523" />
          <stop offset=".55" stopColor="#0d4e75" />
          <stop offset="1" stopColor="#07111f" />
        </linearGradient>
        <radialGradient id="remotionGlobe" cx="50%" cy="42%" r="60%">
          <stop stopColor="#f1fdff" />
          <stop offset=".22" stopColor="#5ee0ff" />
          <stop offset=".72" stopColor="#0a6795" />
          <stop offset="1" stopColor="#06162a" />
        </radialGradient>
        <linearGradient id="remotionMetal" x1="72" x2="190" y1="48" y2="113">
          <stop stopColor="#ffffff" />
          <stop offset=".48" stopColor="#cbd7e8" />
          <stop offset=".78" stopColor="#61718a" />
          <stop offset="1" stopColor="#fbfdff" />
        </linearGradient>
      </defs>

      <g
        transform={`translate(128 128) scale(${interpolate(intro, [0, 1], [0.94, 1])}) translate(-128 -128)`}
      >
        <path
          fill="#02050b"
          d="M128 9c41 0 75 8 94 21v78c0 58-39 111-94 135C73 219 34 166 34 108V30C53 17 87 9 128 9Z"
        />
        <path
          fill="url(#remotionShield)"
          d="M128 15c38 0 70 7 88 18v74c0 54-36 103-88 126-52-23-88-72-88-126V33c18-11 50-18 88-18Z"
        />
        <path
          fill="#07101d"
          d="M128 23c34 0 62 6 80 16v67c0 49-32 94-80 116-48-22-80-67-80-116V39c18-10 46-16 80-16Z"
        />
        <path
          fill="url(#remotionRed)"
          d="M58 44c18-8 42-12 70-12s52 4 70 12v58c-19 9-42 13-70 13s-51-4-70-13V44Z"
        />
        <path
          fill="#071425"
          d="M58 108c20 8 43 12 70 12s50-4 70-12v38c-20 8-44 13-70 13s-50-5-70-13v-38Z"
        />
        <path
          fill="url(#remotionBlue)"
          d="M58 151c19 8 43 12 70 12s51-4 70-12c-8 31-32 58-70 76-38-18-62-45-70-76Z"
        />

        <g opacity={0.65 + pulse * 0.28} fill="none" strokeLinecap="round">
          <path stroke="#ff4037" strokeWidth="2" d="M70 72h28l8-8 12 23 11-34 13 44 9-25h33" />
          <path stroke="#5ed5ff" strokeWidth="1.8" d="M68 138h34m53 0h33M84 153h22m47 0h22" />
          <path stroke="#ff6a4a" strokeWidth="1.6" d="M74 54h17m18-7h5m12-3h3m12 5h4m17 10h13" />
        </g>

        <g style={{ opacity: draw }}>
          <path
            fill="url(#remotionMetal)"
            stroke="#0b1b2e"
            strokeWidth="3"
            d="M88 75c9-21 34-25 52-20l16-11 9 6-10 18 17 8c-10 9-24 10-38 6l-24 17-24-6-10 9-10-4 11-17 11-6Z"
          />
          <path fill="#0e2743" d="M101 71c13 0 21-5 33-9l-22 24-18-5 7-10Z" />
          <path
            fill="#f2f7ff"
            stroke="#0b1b2e"
            strokeWidth="3"
            d="M139 82l34 3 13 12-11 12-29-8-19 11-25-7 26-21 11-2Z"
          />
          <circle cx="128" cy="82" r="7" fill="#ff2d2d" stroke="#f9d4d4" strokeWidth="2" />
          <circle cx="88" cy="132" r="15" fill="#c51620" stroke="#f0d1d3" strokeWidth="5" />
          <circle cx="168" cy="132" r="15" fill="#c51620" stroke="#f0d1d3" strokeWidth="5" />
          <circle cx="88" cy="132" r="5" fill="#fff7f7" />
          <circle cx="168" cy="132" r="5" fill="#fff7f7" />
          <circle
            cx="128"
            cy="178"
            r="31"
            fill="url(#remotionGlobe)"
            stroke="#a8ecff"
            strokeWidth="2"
          />
          <path
            fill="none"
            stroke="#a8ecff"
            strokeWidth="1.4"
            d="M101 169c19 6 35 3 54-10M100 184c17-2 33 0 56 12M124 148c-5 18-4 38 2 60M143 154c-7 12-14 29-15 52"
          />
          <path
            fill="#f7fbff"
            d="M105 198c11-4 21-4 31 2v18c-10-5-20-5-31-1v-19Zm33 2c8-5 15-5 24-2v18c-8-3-16-3-24 2v-18Z"
          />
        </g>

        <path
          fill="none"
          stroke="#f8fbff"
          strokeWidth="3"
          d="M128 23c34 0 62 6 80 16v67c0 49-32 94-80 116-48-22-80-67-80-116V39c18-10 46-16 80-16Z"
          opacity=".42"
        />
        <rect x="44" y={scan} width="168" height="10" fill="rgba(94, 200, 255, 0.18)" />
      </g>
    </svg>
  );
};

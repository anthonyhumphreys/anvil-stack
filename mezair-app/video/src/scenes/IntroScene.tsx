import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
  Sequence,
} from 'remotion';
import { loadFont } from '@remotion/google-fonts/IBMPlexSans';
import { MezairMark } from '../components/MezairMark';

const { fontFamily } = loadFont('normal', {
  weights: ['400', '700'],
  subsets: ['latin'],
});

export const IntroScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const iconScale = spring({ frame, fps, config: { damping: 12 } });
  const titleOpacity = interpolate(frame, [20, 50], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const titleY = interpolate(frame, [20, 50], [30, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const taglineOpacity = interpolate(frame, [50, 80], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const taglineY = interpolate(frame, [50, 80], [20, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        background: 'linear-gradient(135deg, #0a0a0c 0%, #0d1117 50%, #0a0a0c 100%)',
        justifyContent: 'center',
        alignItems: 'center',
        fontFamily,
      }}
    >
      {/* Icon */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 24,
        }}
      >
        <div
          style={{
            transform: `scale(${iconScale})`,
            width: 120,
            height: 120,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <MezairMark size={120} animated={false} />
        </div>

        <Sequence from={20} layout="none">
          <h1
            style={{
              fontSize: 96,
              fontWeight: 700,
              color: 'white',
              margin: 0,
              opacity: titleOpacity,
              transform: `translateY(${titleY}px)`,
              letterSpacing: -2,
            }}
          >
            mezair
          </h1>
        </Sequence>

        <Sequence from={50} layout="none">
          <p
            style={{
              fontSize: 32,
              color: '#94a3b8',
              margin: 0,
              opacity: taglineOpacity,
              transform: `translateY(${taglineY}px)`,
              fontWeight: 400,
              letterSpacing: 4,
              textTransform: 'uppercase',
            }}
          >
            Developer Mission Control
          </p>
        </Sequence>
      </div>
    </AbsoluteFill>
  );
};

import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
  Img,
  staticFile,
  Sequence,
} from "remotion";
import { loadFont } from "@remotion/google-fonts/IBMPlexSans";

const { fontFamily } = loadFont("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

export const IntroScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const iconScale = spring({ frame, fps, config: { damping: 12 } });
  const titleOpacity = interpolate(frame, [20, 50], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const titleY = interpolate(frame, [20, 50], [30, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const taglineOpacity = interpolate(frame, [50, 80], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const taglineY = interpolate(frame, [50, 80], [20, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const glowOpacity = interpolate(frame, [0, 60], [0, 0.6], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        background: "linear-gradient(135deg, #0a0a0c 0%, #0d1117 50%, #0a0a0c 100%)",
        justifyContent: "center",
        alignItems: "center",
        fontFamily,
      }}
    >
      {/* Background glow */}
      <div
        style={{
          position: "absolute",
          width: 600,
          height: 600,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(124,58,237,0.15) 0%, transparent 70%)",
          opacity: glowOpacity,
        }}
      />

      {/* Icon */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 24,
        }}
      >
        <div
          style={{
            transform: `scale(${iconScale})`,
            width: 120,
            height: 120,
            borderRadius: 28,
            background: "linear-gradient(135deg, #7c3aed, #9333ea)",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            boxShadow: "0 0 60px rgba(124,58,237,0.3)",
          }}
        >
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
            <line x1="12" y1="2" x2="12" y2="22" />
          </svg>
        </div>

        <Sequence from={20} layout="none">
          <h1
            style={{
              fontSize: 96,
              fontWeight: 900,
              color: "white",
              margin: 0,
              opacity: titleOpacity,
              transform: `translateY(${titleY}px)`,
              letterSpacing: -2,
            }}
          >
            Anvil
          </h1>
        </Sequence>

        <Sequence from={50} layout="none">
          <p
            style={{
              fontSize: 32,
              color: "#94a3b8",
              margin: 0,
              opacity: taglineOpacity,
              transform: `translateY(${taglineY}px)`,
              fontWeight: 400,
              letterSpacing: 4,
              textTransform: "uppercase",
            }}
          >
            Developer Mission Control
          </p>
        </Sequence>
      </div>
    </AbsoluteFill>
  );
};

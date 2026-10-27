import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
  Sequence,
} from "remotion";
import { loadFont } from "@remotion/google-fonts/IBMPlexSans";

const { fontFamily } = loadFont("normal", {
  weights: ["400", "600", "700"],
  subsets: ["latin"],
});

export const OutroScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const ctaSpring = spring({ frame, fps, config: { damping: 12 } });
  const ctaScale = interpolate(ctaSpring, [0, 1], [0.6, 1]);

  const subOpacity = interpolate(frame, [30, 60], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const subY = interpolate(frame, [30, 60], [20, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const logoOpacity = interpolate(frame, [60, 90], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const glowPulse = interpolate(
    frame % 60,
    [0, 30, 60],
    [0.3, 0.6, 0.3],
  );

  return (
    <AbsoluteFill
      style={{
        background: "linear-gradient(135deg, #0a0a0c 0%, #0d1117 50%, #0a0a0c 100%)",
        fontFamily,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      {/* Background glow */}
      <div
        style={{
          position: "absolute",
          width: 800,
          height: 800,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(124,58,237,0.12) 0%, transparent 70%)",
          opacity: glowPulse,
        }}
      />

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 32,
        }}
      >
        <div
          style={{
            opacity: ctaSpring,
            transform: `scale(${ctaScale})`,
            textAlign: "center",
          }}
        >
          <h2
            style={{
              fontSize: 72,
              fontWeight: 900,
              color: "white",
              margin: 0,
              lineHeight: 1.2,
            }}
          >
            Get productive in
          </h2>
          <h2
            style={{
              fontSize: 72,
              fontWeight: 900,
              color: "#7c3aed",
              margin: 0,
              lineHeight: 1.2,
            }}
          >
            under 30 minutes
          </h2>
        </div>

        <Sequence from={30} layout="none">
          <p
            style={{
              fontSize: 24,
              color: "#94a3b8",
              margin: 0,
              opacity: subOpacity,
              transform: `translateY(${subY}px)`,
              textAlign: "center",
              maxWidth: 600,
              lineHeight: 1.5,
            }}
          >
            AI-powered developer onboarding, repository analysis, and
            intelligent workflows — all in one tool.
          </p>
        </Sequence>

        <Sequence from={60} layout="none">
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 16,
              marginTop: 32,
              opacity: logoOpacity,
            }}
          >
            <p
              style={{
                fontSize: 18,
                color: "#64748b",
                margin: 0,
                letterSpacing: 3,
                textTransform: "uppercase",
              }}
            >
              AnthonyHumphreys.dev
            </p>
          </div>
        </Sequence>
      </div>
    </AbsoluteFill>
  );
};

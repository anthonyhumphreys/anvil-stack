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

const problems = [
  { icon: "📁", text: "Days reading unfamiliar code" },
  { icon: "🔍", text: "Context scattered across tools" },
  { icon: "📋", text: "Outdated documentation" },
  { icon: "⏳", text: "Slow onboarding, lost productivity" },
];

export const ProblemScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const headingOpacity = interpolate(frame, [0, 20], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        background: "linear-gradient(135deg, #0a0a1a 0%, #1a0a0a 100%)",
        justifyContent: "center",
        alignItems: "center",
        fontFamily,
        padding: 120,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 48,
          width: "100%",
        }}
      >
        <h2
          style={{
            fontSize: 64,
            fontWeight: 800,
            color: "white",
            margin: 0,
            opacity: headingOpacity,
            textAlign: "center",
          }}
        >
          Sound <span style={{ color: "#f87171" }}>familiar</span>?
        </h2>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 24,
            width: "100%",
            maxWidth: 900,
          }}
        >
          {problems.map((problem, i) => {
            const delay = 15 + i * 15;
            const itemSpring = spring({
              frame,
              fps,
              delay,
              config: { damping: 200 },
            });
            const x = interpolate(itemSpring, [0, 1], [-100, 0]);
            return (
              <Sequence key={i} from={delay} layout="none">
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 24,
                    padding: "20px 32px",
                    background: "rgba(248,113,113,0.08)",
                    borderRadius: 16,
                    borderLeft: "4px solid #f87171",
                    opacity: itemSpring,
                    transform: `translateX(${x}px)`,
                  }}
                >
                  <span style={{ fontSize: 36 }}>{problem.icon}</span>
                  <span
                    style={{
                      fontSize: 28,
                      color: "#e2e8f0",
                      fontWeight: 600,
                    }}
                  >
                    {problem.text}
                  </span>
                </div>
              </Sequence>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};

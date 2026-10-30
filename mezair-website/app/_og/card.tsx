import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { MARK_LEG, MARK_NECK, MARK_TAIL, MARK_VIEWBOX } from "@/components/site/mark-geometry";

/*
 * Social cards for every public page. They use the projection-room palette
 * (sRGB equivalents of the OKLCH tokens, which satori cannot parse), the wide
 * Archivo display voice, and real Desktop captures where a page has one.
 */

export const cardSize = { width: 1200, height: 630 };
export const cardContentType = "image/png";

const color = {
  ground: "#060a17",
  window: "#080e1d",
  text: "#f0f4f7",
  muted: "#acb5c1",
  rule: "#262e3d",
  live: "#ff8f34",
  key: "#253c67"
};

const root = process.cwd();
const fonts = Promise.all([
  readFile(join(root, "app/_og/fonts/Archivo-Expanded-ExtraBold.woff")),
  readFile(join(root, "app/_og/fonts/Archivo-Medium.woff")),
  readFile(join(root, "app/_og/fonts/JetBrainsMono-Medium.woff"))
]);

async function asset(name: string) {
  const data = await readFile(join(root, "app/_og/assets", name));
  return `data:image/jpeg;base64,${data.toString("base64")}`;
}

function Mark({ size, opacity = 1 }: { size: number; opacity?: number }) {
  return (
    <svg width={size * 1.52} height={size} viewBox={MARK_VIEWBOX} style={{ opacity }}>
      <path d={MARK_TAIL.d} transform={MARK_TAIL.transform} fill={color.text} />
      <path d={MARK_NECK.d} transform={MARK_NECK.transform} fill={color.text} />
      <path d={MARK_LEG.d} transform={MARK_LEG.transform} fill={color.text} />
    </svg>
  );
}

export type CardOptions = {
  title: string;
  description?: string;
  /** Top-right label: the page or product. */
  label?: string;
  /** Live status pill, shown in the orange accent. */
  status?: string;
  /** Mono facts along the bottom edge. */
  facts?: string[];
  /** A real capture from app/_og/assets, shown as a lit window bleeding off the edge. */
  image?: { file: string; width: number; height: number; top?: number };
  /** Wordmark-only treatment with a large mark. */
  variant?: "default" | "mark";
};

export async function renderCard({ title, description, label, status, facts, image, variant = "default" }: CardOptions) {
  const [display, body, mono] = await fonts;
  const src = image ? await asset(image.file) : null;
  const titleSize = variant === "mark" ? 84 : image ? (title.length > 34 ? 56 : 66) : title.length > 48 ? 62 : 74;
  const textWidth = image ? 600 : 980;
  const imageWidth = 760;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          position: "relative",
          overflow: "hidden",
          background: color.ground,
          color: color.text,
          fontFamily: "Archivo"
        }}
      >
        {/* Cool key light pooled under the staged object. */}
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: 1200,
            height: 630,
            background: `radial-gradient(ellipse 70% 75% at ${image ? "78% 92%" : "62% 105%"}, rgba(37,60,103,0.9) 0%, rgba(37,60,103,0.35) 38%, rgba(6,10,23,0) 72%)`,
            display: "flex"
          }}
        />

        {variant === "mark" ? (
          <div style={{ position: "absolute", right: 64, top: 150, display: "flex" }}>
            <Mark size={290} />
          </div>
        ) : !image ? (
          <div style={{ position: "absolute", right: -60, bottom: -40, display: "flex" }}>
            <Mark size={380} opacity={0.07} />
          </div>
        ) : null}

        {src && image ? (
          <div
            style={{
              position: "absolute",
              left: 600,
              top: image.top ?? 128,
              width: imageWidth,
              height: Math.round((imageWidth * image.height) / image.width),
              display: "flex",
              borderRadius: 18,
              overflow: "hidden",
              border: `1px solid ${color.rule}`,
              boxShadow: "0 40px 90px rgba(0,0,0,0.65)"
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} width={imageWidth} height={Math.round((imageWidth * image.height) / image.width)} alt="" />
          </div>
        ) : null}

        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: 1200,
            height: 630,
            display: "flex",
            flexDirection: "column",
            padding: "56px 64px"
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <Mark size={34} />
              <div style={{ fontSize: 30, letterSpacing: -0.6, fontFamily: "Archivo Expanded", display: "flex" }}>Mezair</div>
            </div>
            {label ? (
              <div style={{ display: "flex", fontFamily: "JetBrains Mono", fontSize: 19, color: color.muted }}>{label}</div>
            ) : null}
          </div>

          <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", flexGrow: 1, width: textWidth }}>
            {status ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 26 }}>
                <div style={{ width: 12, height: 12, borderRadius: 9999, background: color.live, display: "flex" }} />
                <div style={{ display: "flex", fontFamily: "JetBrains Mono", fontSize: 20, color: color.live }}>{status}</div>
              </div>
            ) : null}
            <div
              style={{
                display: "flex",
                fontFamily: "Archivo Expanded",
                fontSize: titleSize,
                lineHeight: 1,
                letterSpacing: -titleSize * 0.03,
                maxWidth: variant === "mark" ? 600 : textWidth
              }}
            >
              {title}
            </div>
            {description ? (
              <div
                style={{
                  display: "flex",
                  marginTop: 26,
                  fontSize: 27,
                  lineHeight: 1.38,
                  color: color.muted,
                  maxWidth: image ? 500 : variant === "mark" ? 540 : 860
                }}
              >
                {description}
              </div>
            ) : null}
          </div>

          {facts?.length ? (
            <div style={{ display: "flex", gap: 22, fontFamily: "JetBrains Mono", fontSize: 18, color: color.muted }}>
              {facts.map((fact, index) => (
                <div key={fact} style={{ display: "flex", gap: 22 }}>
                  {index > 0 ? <div style={{ display: "flex", color: color.rule }}>/</div> : null}
                  <div style={{ display: "flex" }}>{fact}</div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    ),
    {
      ...cardSize,
      fonts: [
        { name: "Archivo Expanded", data: display, weight: 800, style: "normal" },
        { name: "Archivo", data: body, weight: 500, style: "normal" },
        { name: "JetBrains Mono", data: mono, weight: 500, style: "normal" }
      ]
    }
  );
}

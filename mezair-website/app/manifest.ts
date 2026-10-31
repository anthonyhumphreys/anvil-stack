import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Mezair",
    short_name: "Mezair",
    description: "Run Codex, Cursor, Devin and more from one desktop app. Bring your own subscriptions.",
    start_url: "/",
    display: "browser",
    background_color: "#060a17",
    theme_color: "#060a17",
    icons: [
      { src: "/mezair-mark.svg", type: "image/svg+xml", sizes: "any" },
      { src: "/mezair-icon.png", type: "image/png", sizes: "512x512" }
    ]
  };
}

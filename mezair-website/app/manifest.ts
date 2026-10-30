import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Mezair",
    short_name: "Mezair",
    description: "A free, open-source desktop app for running coding agents on your own repos.",
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

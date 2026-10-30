import { cardContentType, cardSize, renderCard } from "./_og/card";

export const alt = "Mezair, a free, open-source desktop app for running coding agents on your own repositories, with a screenshot of a finished Codex run.";
export const size = cardSize;
export const contentType = cardContentType;

export default function Image() {
  return renderCard({
    title: "Put your agents in motion.",
    description: "A free, open-source desktop app for running coding agents on your own repositories.",
    label: "mezair.dev",
    facts: ["Free", "MIT", "macOS · Windows · Linux"],
    image: { file: "desktop.jpg", width: 1400, height: 875, top: 150 }
  });
}

import { cardContentType, cardSize, renderCard } from "./_og/card";

export const alt = "Mezair, an open-source desktop app for Codex, Cursor, Devin and other coding agents, with a screenshot of a finished Codex run.";
export const size = cardSize;
export const contentType = cardContentType;

export default function Image() {
  return renderCard({
    title: "Put your agents in motion.",
    description: "Run Codex, Cursor, Devin and more from one desktop app. Bring your own subscriptions.",
    label: "mezair.dev",
    facts: ["Free", "MIT", "macOS · Windows · Linux"],
    image: { file: "desktop.jpg", width: 1400, height: 875, top: 150 }
  });
}

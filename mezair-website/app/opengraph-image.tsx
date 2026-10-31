import { cardContentType, cardSize, renderCard } from "./_og/card";

export const alt = "Mezair, an open-source desktop app for Codex, Cursor, Devin and other coding agents, with a screenshot of a finished Codex run.";
export const size = cardSize;
export const contentType = cardContentType;

export default function Image() {
  return renderCard({
    title: "Put your agents in motion.",
    description: "The open-source workbench for coding agents. You set the direction. Mezair carries it forward.",
    label: "mezair.dev",
    facts: ["Free", "MIT", "macOS · Windows · Linux"],
    image: { file: "desktop.jpg", width: 1400, height: 875, top: 150 }
  });
}

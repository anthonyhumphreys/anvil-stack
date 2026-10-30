import { cardContentType, cardSize, renderCard } from "../_og/card";

export const alt = "Mezair documentation for Desktop, Sync & Mesh, Registry, Node Base and Cloud.";
export const size = cardSize;
export const contentType = cardContentType;

export default function Image() {
  return renderCard({
    title: "Mezair documentation",
    description: "How to install, use and extend Desktop, Sync & Mesh, Registry, Node Base and Cloud.",
    label: "mezair.dev/docs",
    facts: ["Learn", "Build", "Reference"]
  });
}

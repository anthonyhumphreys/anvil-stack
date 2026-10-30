import { cardContentType, cardSize, renderCard } from "../_og/card";

export const alt = "Mezair pricing: Desktop is free. Hosted Sync is planned from £6 a month, and self-hosting is free.";
export const size = cardSize;
export const contentType = cardContentType;

export default function Image() {
  return renderCard({
    title: "Desktop is free. Hosted Sync is planned from £6 a month.",
    description: "The desktop app costs nothing. You can self-host Sync & Mesh for free or request the hosted beta.",
    label: "Pricing",
    facts: ["Desktop free", "Self-host free", "Hosted from £6/mo"]
  });
}

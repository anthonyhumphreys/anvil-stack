import { cardContentType, cardSize, renderCard } from "../_og/card";

export const alt = "Mezair pricing. The app is free. Sync & Mesh is free on a backend you run, or £8.99 a month if Mezair hosts it.";
export const size = cardSize;
export const contentType = cardContentType;

export default function Image() {
  return renderCard({
    title: "The app is free. Hosted Sync is £8.99 a month.",
    description: "Sync & Mesh is free on a backend you run. Our hosting is an invite-only beta for now.",
    label: "Pricing",
    facts: ["App free", "Self-hosted Sync free", "Hosted Sync £8.99 a month"]
  });
}

import { cardContentType, cardSize, renderCard } from "../_og/card";

export const alt = "Mezair pricing. The app is free. Sync & Mesh is free on a backend you run, or £8.99 a month if Mezair hosts it.";
export const size = cardSize;
export const contentType = cardContentType;

export default function Image() {
  return renderCard({
    title: "Pricing",
    description: "The app is free. Self-host Sync & Mesh for free, or choose our invite-only hosted beta.",
    label: "Pricing",
    facts: ["App free", "Self-hosted Sync free", "Hosted Sync £8.99 a month"]
  });
}

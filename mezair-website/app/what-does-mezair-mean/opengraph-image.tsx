import { cardContentType, cardSize, renderCard } from "../_og/card";

export const alt = "Mezair, pronounced may-ZAIR, is a classical dressage movement of controlled rises that carry the horse forward.";
export const size = cardSize;
export const contentType = cardContentType;

export default function Image() {
  return renderCard({
    title: "What does Mezair mean?",
    description: "Mezair, pronounced may-ZAIR, is a dressage movement of controlled rises, each carrying the horse forward.",
    label: "What does Mezair mean?",
    variant: "mark"
  });
}

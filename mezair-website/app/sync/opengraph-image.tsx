import { cardContentType, cardSize, renderCard } from "../_og/card";

export const alt = "Mezair Sync & Mesh: encrypted sync between your machines, jobs on your other machines and session handoff, with a screenshot of the Mesh jobs list.";
export const size = cardSize;
export const contentType = cardContentType;

export default function Image() {
  return renderCard({
    title: "Use Mezair on all your machines",
    description: "Encrypted sync, jobs on your other machines and session handoff.",
    label: "Sync & Mesh",
    status: "Beta through 30 November 2026",
    facts: ["AES-256-GCM", "LAN first", "Self-host free"],
    image: { file: "mesh-jobs.jpg", width: 1100, height: 1376, top: 96 }
  });
}

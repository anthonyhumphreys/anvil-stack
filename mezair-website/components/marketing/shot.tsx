import Image from "next/image";
import { screen, type ScreenId } from "@/lib/screens";

/** A real Mezair capture in a lit frame, with its caption beneath. */
export function Shot({
  id,
  sizes = "(min-width: 1024px) 50vw, 94vw",
  caption = true,
  priority = false,
  className
}: {
  id: ScreenId;
  sizes?: string;
  caption?: boolean | string;
  priority?: boolean;
  className?: string;
}) {
  const shot = screen(id);
  return (
    <figure className={className}>
      <div className="shot" data-panel={shot.panel ? "true" : undefined}>
        <Image src={shot.file} width={shot.width} height={shot.height} alt={shot.alt} sizes={sizes} priority={priority} />
      </div>
      {caption ? <figcaption className="shot-caption">{typeof caption === "string" ? caption : shot.caption}</figcaption> : null}
    </figure>
  );
}

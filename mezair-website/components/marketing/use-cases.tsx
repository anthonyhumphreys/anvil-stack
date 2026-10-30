"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { screen, type ScreenId } from "@/lib/screens";

export type UseCase = {
  id: string;
  title: string;
  body: string;
  shot: ScreenId;
  fit?: "panel";
  /** A command, prompt or state that grounds the claim. */
  detail?: string;
  link: { label: string; href: string };
  status?: string;
};

/**
 * Jobs people hand to Mezair, each beside the real screen it produces. On
 * wide screens the captures share one sticky stage that follows the step in
 * view; on narrow screens each step carries its own capture.
 */
export function UseCases({ items }: { items: UseCase[] }) {
  const [active, setActive] = useState(0);
  const refs = useRef<Array<HTMLElement | null>>([]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(Number((entry.target as HTMLElement).dataset.index));
        }
      },
      { rootMargin: "-45% 0px -45% 0px" }
    );
    for (const element of refs.current) if (element) observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="uses-wrap">
      <ol className="uses">
        {items.map((item, index) => {
          const shot = screen(item.shot);
          return (
            <li
              key={item.id}
              ref={(element) => {
                refs.current[index] = element;
              }}
              data-index={index}
              data-active={index === active}
              className="use"
            >
              <div>
                <h3 className="use-title">{item.title}</h3>
                <p className="use-body">{item.body}</p>
                <p className="use-meta">
                  {item.detail ? <code>{item.detail}</code> : null}
                  {item.status ? <span>{item.status}</span> : null}
                  <Link href={item.link.href} className="cine-link">
                    {item.link.label}
                  </Link>
                </p>
              </div>
              <figure className="use-inline-shot">
                <div className="shot" data-panel={shot.panel ? "true" : undefined}>
                  <Image src={shot.file} width={shot.width} height={shot.height} alt={shot.alt} sizes="94vw" />
                </div>
              </figure>
            </li>
          );
        })}
      </ol>

      <div className="uses-stage" aria-hidden="true">
        <div className="uses-stage-frame">
          {items.map((item, index) => {
            const shot = screen(item.shot);
            return (
              <div key={item.id} className="reel-slide" data-active={index === active} data-fit={item.fit}>
                <Image src={shot.file} width={shot.width} height={shot.height} alt="" sizes="(min-width: 1400px) 760px, 56vw" />
              </div>
            );
          })}
        </div>
        <p className="shot-caption">{screen(items[active].shot).caption}</p>
      </div>
    </div>
  );
}

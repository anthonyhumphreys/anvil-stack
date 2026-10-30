"use client";

import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { MezairMark } from "@/components/site/mezair-mark";
import styles from "@/app/what-does-mezair-mean/meaning.module.css";

export function Horseplay() {
  const [hops, setHops] = useState(0);

  return (
    <figure className={styles.horseplay}>
      <div className={styles.arena} aria-hidden="true">
        <div key={hops} className={`${styles.horse} ${hops > 0 ? styles.hop : ""}`}>
          <MezairMark className={styles.mark} />
        </div>
        <span className={styles.ground} />
      </div>
      <figcaption className={styles.caption}>
        <p aria-live="polite" aria-atomic="true">
          {hops === 0
            ? "The M has a mane."
            : hops % 3 === 0
              ? "That's enough horseplay."
              : "A little lift. Onward."}
        </p>
        <button type="button" onClick={() => setHops((value) => value + 1)}>
          A little horseplay <ArrowUpRight size={17} aria-hidden="true" />
        </button>
      </figcaption>
    </figure>
  );
}

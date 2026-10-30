import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { SiteHeader } from "@/components/site/header";
import { SiteFooter } from "@/components/site/footer";
import { Horseplay } from "@/components/site/horseplay";
import { pageMetadata } from "@/lib/metadata";
import styles from "./meaning.module.css";

export const metadata: Metadata = pageMetadata({
  title: "What does Mezair mean? | Mezair",
  description:
    "Mezair, pronounced may-ZAIR, is a classical dressage movement in which the horse makes a series of controlled rises, each carrying it forward.",
  path: "/what-does-mezair-mean"
});

export default function MeaningPage() {
  return (
    <div className={`cine ${styles.page}`}>
      <SiteHeader showThemeToggle={false} />
      <main id="main-content" className={`page-shell ${styles.main}`}>
        <div className={styles.intro}>
          <h1 className={`font-display ${styles.title}`}>What does Mezair mean?</h1>
          <div className={styles.definition}>
            <p className={styles.word}>Mezair <span>may-ZAIR</span></p>
            <p>
              A classical dressage movement. The horse makes a series of controlled rises, and each
              one carries it forward. It is one of the traditional airs above the ground.
            </p>
            <p className={styles.aside}>The rider sets the direction and the horse supplies the power.</p>
          </div>
        </div>

        <Horseplay />

        <div className={styles.afterword}>
          <div>
            <h2 className="font-display">Why we chose the name</h2>
            <p>
              In Mezair, agents do the work and you decide what they work on, approve what they
              change and choose what to keep.
            </p>
            <p className={styles.sources}>
              From the French <em>mézair</em>. Definitions:{" "}
              <a href="https://www.dictionary.com/browse/mezair">Dictionary.com <ArrowUpRight size={12} aria-hidden="true" /></a>
              {" · "}
              <a href="https://www.dictionnaire-academie.fr/article/A5M0750">Académie française <ArrowUpRight size={12} aria-hidden="true" /></a>
              {" · "}
              <a href="https://fr.wikisource.org/wiki/Encyclop%C3%A9die_m%C3%A9thodique/Arts_acad%C3%A9miques/Equitation/Airs_%28%C3%A9quitation%29">The traditional airs <ArrowUpRight size={12} aria-hidden="true" /></a>
            </p>
          </div>
          <Link href="/" className={styles.back}>
            <ArrowLeft size={18} aria-hidden="true" /> Back to the home page
          </Link>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

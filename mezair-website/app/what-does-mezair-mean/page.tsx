import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { SiteHeader } from "@/components/site/header";
import { SiteFooter } from "@/components/site/footer";
import { Horseplay } from "@/components/site/horseplay";
import styles from "./meaning.module.css";

export const metadata: Metadata = {
  title: "What does Mezair mean? | Mezair",
  description:
    "Power under precise control. Discover the classical dressage movement behind Mezair: strength, discipline, forward motion, and a little horseplay."
};

export default function MeaningPage() {
  return (
    <div className={`cine ${styles.page}`}>
      <SiteHeader showThemeToggle={false} />
      <main id="main-content" className={`page-shell ${styles.main}`}>
        <div className={styles.intro}>
          <h1 className={`font-display ${styles.title}`}>Power.<br />Under control.</h1>
          <div className={styles.definition}>
            <p className={styles.word}>Mezair <span>may-ZAIR</span></p>
            <p>
              A classical dressage movement: a sequence of powerful, controlled rises, each
              carrying the horse forward. One of the traditional airs above the ground.
            </p>
            <p className={styles.aside}>Strength. Discipline. Progression. Elegance.</p>
          </div>
        </div>

        <Horseplay />

        <div className={styles.afterword}>
          <div>
            <h2 className="font-display">You set the direction.<br />Agents carry it forward.</h2>
            <p>
              Strength under precise control. Complex movements, carefully coordinated. That’s the
              idea behind Mezair: agents do the work, orchestration brings it together, and you stay
              in command.
            </p>
            <p className={styles.sources}>
              From the French <em>mézair</em>. A real word, with a little horsepower:{" "}
              <a href="https://www.dictionary.com/browse/mezair">Dictionary.com <ArrowUpRight size={12} aria-hidden="true" /></a>
              {" · "}
              <a href="https://www.dictionnaire-academie.fr/article/A5M0750">Académie française <ArrowUpRight size={12} aria-hidden="true" /></a>
              {" · "}
              <a href="https://fr.wikisource.org/wiki/Encyclop%C3%A9die_m%C3%A9thodique/Arts_acad%C3%A9miques/Equitation/Airs_%28%C3%A9quitation%29">The traditional airs <ArrowUpRight size={12} aria-hidden="true" /></a>
            </p>
          </div>
          <Link href="/" className={styles.back}>
            <ArrowLeft size={18} aria-hidden="true" /> Back to the workbench
          </Link>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

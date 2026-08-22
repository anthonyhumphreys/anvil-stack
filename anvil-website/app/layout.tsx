import type { Metadata } from "next";
import { Archivo, JetBrains_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { ThemeScript } from "@/components/site/theme-script";
import "./globals.css";

const archivo = Archivo({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap"
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap"
});

export const metadata: Metadata = {
  title: "Anvil | Open source tools for inspectable developer work",
  description: "Anvil is an open source family of developer tools: Anvil Desktop for repo-aware agent delivery, Anvil Registry for npm dependency policy, Anvil Node Base for safer installs, and Anvil Cloud for inspectable Cell runtime contracts.",
  metadataBase: new URL("https://anvil.dev"),
  openGraph: {
    title: "Anvil | Open source tools for inspectable developer work",
    description: "Repo-aware agent delivery work, safer npm installs, hardened Node devcontainers, and inspectable Anvil Cell runtime workflows.",
    type: "website"
  },
  twitter: {
    card: "summary_large_image",
    title: "Anvil | Inspectable developer tooling",
    description: "Open source local-first tooling for agent delivery work, npm supply-chain safety, and provider-neutral app runtime contracts."
  }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${archivo.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body>
        <a href="#main-content" className="skip-link">Skip to content</a>
        {children}
        <Analytics />
      </body>
    </html>
  );
}

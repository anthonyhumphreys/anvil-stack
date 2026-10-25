import type { Metadata } from "next";
import { Archivo, JetBrains_Mono } from "next/font/google";
import { PrivateAnalytics } from "@/components/site/private-analytics";
import { ThemeScript } from "@/components/site/theme-script";
import "./globals.css";

// Variable Archivo with the width axis: normal width for text, set wide for display.
const archivo = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-sans",
  display: "swap"
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap"
});

const description =
  "Anvil is a free, open-source desktop app for running coding agents on your own repos. Plan the work, watch it happen, and review every change. Add paid hosted Sync & Mesh to work across machines, or self-host for free.";

export const metadata: Metadata = {
  title: "Anvil | A workbench for coding agents",
  description,
  metadataBase: new URL("https://anvil.dev"),
  icons: {
    icon: [{ url: "/anvil-mark.svg", type: "image/svg+xml" }],
    shortcut: ["/anvil-mark.svg"]
  },
  openGraph: {
    title: "Anvil | A workbench for coding agents",
    description,
    type: "website"
  },
  twitter: {
    card: "summary_large_image",
    title: "Anvil | A workbench for coding agents",
    description
  }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${archivo.variable} ${mono.variable}`} data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body>
        <a href="#main-content" className="skip-link">Skip to content</a>
        {children}
        <PrivateAnalytics />
      </body>
    </html>
  );
}

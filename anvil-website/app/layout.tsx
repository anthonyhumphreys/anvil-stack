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
  title: "Anvil | Open source developer tools",
  description: "Anvil Desktop is an open source app for agent workflows on your own repos — with Sync & Mesh keeping your machines in step, and an npm policy gateway, hardened Node image, and portable runtime in the stack behind it.",
  metadataBase: new URL("https://anvil.dev"),
  openGraph: {
    title: "Anvil | Open source developer tools",
    description: "An open source desktop app for agent workflows on your repos. Sync & Mesh keeps every machine you own in step; the rest of the stack is there when you want it.",
    type: "website"
  },
  twitter: {
    card: "summary_large_image",
    title: "Anvil | Open source developer tools",
    description: "Open source desktop app for agent workflows on your repos — plus an end-to-end encrypted sync layer and companion OSS tools."
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

import type { Metadata, Viewport } from "next";
import { Archivo, JetBrains_Mono } from "next/font/google";
import { PrivateAnalytics } from "@/components/site/private-analytics";
import { ThemeScript } from "@/components/site/theme-script";
import { siteName, siteUrl } from "@/lib/metadata";
import { githubRepositoryUrl, latestDesktopDmgUrl } from "@/lib/site";
import "./globals.css";
import "./marketing.css";
import "./mark.css";

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

const title = "Mezair | Put your agents in motion";
const description =
  "The open-source workbench for coding agents. Bring your own models, and hold the reins. Free, with optional hosted sync for £6 a month.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title,
  description,
  applicationName: siteName,
  authors: [{ name: "Anthony Humphreys", url: githubRepositoryUrl }],
  creator: "Anthony Humphreys",
  keywords: [
    "coding agents",
    "AI coding",
    "Codex",
    "Cursor",
    "Devin",
    "desktop app",
    "open source",
    "code review",
    "software factories",
    "encrypted sync",
    "remote execution",
    "developer tools"
  ],
  category: "developer tools",
  alternates: { canonical: "/" },
  icons: {
    icon: [{ url: "/mezair-mark.svg", type: "image/svg+xml" }],
    shortcut: ["/mezair-mark.svg"],
    apple: [{ url: "/mezair-icon.png", sizes: "512x512", type: "image/png" }]
  },
  openGraph: {
    title,
    description,
    type: "website",
    url: "/",
    siteName,
    locale: "en_GB"
  },
  twitter: {
    card: "summary_large_image",
    title,
    description
  },
  formatDetection: { telephone: false, email: false, address: false }
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#060a17" },
    { media: "(prefers-color-scheme: light)", color: "#f7f9fb" }
  ],
  colorScheme: "dark light"
};

const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      "@id": `${siteUrl}/#desktop`,
      name: "Mezair Desktop",
      applicationCategory: "DeveloperApplication",
      operatingSystem: "macOS, Windows, Linux",
      description,
      url: siteUrl,
      downloadUrl: latestDesktopDmgUrl,
      license: "https://opensource.org/licenses/MIT",
      isAccessibleForFree: true,
      offers: { "@type": "Offer", price: "0", priceCurrency: "GBP" },
      image: `${siteUrl}/opengraph-image`,
      codeRepository: githubRepositoryUrl
    },
    {
      "@type": "WebSite",
      "@id": `${siteUrl}/#website`,
      name: siteName,
      url: siteUrl
    }
  ]
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${archivo.variable} ${mono.variable}`} data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        <ThemeScript />
        <script
          type="application/ld+json"
          // Static, site-owned JSON; no user input reaches it.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />
      </head>
      <body>
        <a href="#main-content" className="skip-link">Skip to content</a>
        {children}
        <PrivateAnalytics />
      </body>
    </html>
  );
}

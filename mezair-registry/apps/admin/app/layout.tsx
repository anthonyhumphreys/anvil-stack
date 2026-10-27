import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mezair Admin",
  description: "Policy decisions, analysis reports, overrides, and audit events for Mezair Registry."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

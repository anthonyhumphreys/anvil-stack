import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Anvil Admin",
  description: "Policy decisions, analysis reports, overrides, and audit events for Anvil Registry."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

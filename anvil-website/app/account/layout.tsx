import type { Metadata } from "next";
import { AccountChrome } from "@/components/account/account-chrome";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Account | Anvil",
  robots: { index: false, follow: false }
};

export default function AccountLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <AccountChrome>{children}</AccountChrome>;
}

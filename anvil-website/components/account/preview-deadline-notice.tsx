"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const FIRST_NOTICE = Date.UTC(2026, 9, 1);
const SECOND_NOTICE = Date.UTC(2026, 9, 17);
const FINAL_NOTICE = Date.UTC(2026, 9, 28);
const PAID_ENFORCEMENT = Date.UTC(2026, 10, 1);
const DAY_MS = 24 * 60 * 60 * 1000;

function previewNotice(now: number): string | null {
  if (now < FIRST_NOTICE || now >= PAID_ENFORCEMENT) return null;
  if (now < SECOND_NOTICE) {
    return "The hosted preview ends on 31 October. Review Personal and Team prices before paid access begins; preview access will not turn into a charge automatically.";
  }
  if (now < FINAL_NOTICE) {
    const days = Math.ceil((PAID_ENFORCEMENT - now) / DAY_MS);
    return `Paid access begins in ${days} days, on 1 November at 00:00 UTC. Review the Personal or Team billing option that fits; preview access will not turn into a charge automatically.`;
  }
  return "The hosted preview ends on 31 October. Paid access begins 1 November at 00:00 UTC; no preview account will be charged automatically.";
}

export function PreviewDeadlineNotice() {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setNow(Date.now()), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const notice = now === null ? null : previewNotice(now);
  if (notice === null) return null;

  return (
    <aside className="grid gap-3 rounded-md border border-accent/50 bg-[oklch(var(--accent)/0.08)] p-4 sm:flex sm:items-center sm:justify-between">
      <p className="max-w-3xl text-sm leading-6">{notice}</p>
      <div className="flex shrink-0 gap-3 text-sm">
        <Link href="/pricing" className="font-medium underline underline-offset-4">
          Pricing
        </Link>
        <Link href="/account/organizations" className="font-medium underline underline-offset-4">
          Team billing
        </Link>
      </div>
    </aside>
  );
}

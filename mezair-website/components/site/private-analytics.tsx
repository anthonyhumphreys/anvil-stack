"use client";

import { Analytics } from "@vercel/analytics/next";
import { analyticsUrl } from "@/lib/share-fragment";

export function PrivateAnalytics() {
  return <Analytics beforeSend={(event) => {
    const url = analyticsUrl(event.url);
    return url === null ? null : { ...event, url };
  }} />;
}

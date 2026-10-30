"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { preserveShareFragment, restoreShareFragment } from "@/lib/share-fragment";

export function ShareFragmentRecovery({ id }: { id: string }) {
  useEffect(() => { restoreShareFragment(id, window); }, [id]);
  return null;
}

export function ShareSignIn({ id }: { id: string }) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { restoreShareFragment(id, window); }, [id]);
  return (
    <div className="mt-6">
      <Button onClick={() => {
        try {
          preserveShareFragment(id, window);
          // OAuth redirects require a full document navigation rather than an RSC fetch.
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination
          window.location.assign(`/artifacts/${id}/sign-in`);
        } catch (cause) {
          setError(cause instanceof Error && cause.message.includes("decryption key")
            ? cause.message
            : "Your browser couldn't keep the decryption key for sign-in. Allow session storage in this tab, then try again with the full link.");
        }
      }}>Sign in to view</Button>
      <p className="mt-3 text-xs text-muted-foreground">Sign-in checks membership. It does not give this site your account encryption keys or require a paid seat.</p>
      {error && <p role="alert" className="mt-3 text-sm text-muted-foreground">{error}</p>}
    </div>
  );
}

import { authkitProxy } from "@workos-inc/authkit-nextjs";
import { NextResponse } from "next/server";

import { workosConfigured } from "@/lib/workos-env";

// Public paths — everything else matched below requires an AuthKit session.
// `/callback` must stay public: it is the AuthKit redirect target, and
// guarding it would loop sign-in before the session cookie is written.
const unauthenticatedPaths = ["/", "/docs/:path*", "/sync", "/pricing", "/callback"];

// Next 16 file convention is proxy.ts (the WorkOS SDK's authkitProxy is the
// same function as its deprecated authkitMiddleware alias). When WorkOS env
// is absent the site still builds and serves every public page; the account
// area renders its own not-configured panel. The no-op keeps a default
// export so the matcher config stays valid either way.
export default workosConfigured()
  ? authkitProxy({
      middlewareAuth: {
        enabled: true,
        unauthenticatedPaths
      }
    })
  : function proxy() {
      return NextResponse.next();
    };

export const config = {
  matcher: [
    // Run on page routes only — never on static assets, image
    // optimization, or files under public/.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|json|txt|xml|woff|woff2)$).*)"
  ]
};

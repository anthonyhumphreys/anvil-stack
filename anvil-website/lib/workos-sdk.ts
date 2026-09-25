// AuthKit snapshots process.env when its module loads. Centralize its import
// behind this module so the selected deployment values are installed first.
import "@/lib/workos-env";

export { authkitProxy, handleAuth, signOut, withAuth } from "@workos-inc/authkit-nextjs";

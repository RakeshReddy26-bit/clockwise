"use client";

import { useEffect } from "react";

/**
 * Start an app shell at the top when it is first entered.
 *
 * Next.js resets scroll for router navigations (a <Link> click lands at 0), but
 * a `redirect()` issued from inside a Server Action does not — the destination
 * inherits whatever scroll offset the previous page had. Measured on this
 * version, same source page and same destination:
 *
 *   <Link> navigation       500 -> 0     (top)
 *   server-action redirect  500 -> 500   (not top)
 *
 * That is why signing in sometimes drops you part-way down the manager shell:
 * login() is a Server Action, and the login page is scrollable whenever the
 * viewport is short — on a phone, focusing the password field scrolls it for
 * you.
 *
 * Deliberately keyed to MOUNT, not to pathname. The shell layout mounts once
 * when you enter it, so this fires exactly on that entry and never again:
 * navigating between pages inside the shell is untouched (Next already lands
 * those at 0), and browser back/forward scroll restoration inside the shell is
 * left alone.
 */
export function ScrollReset() {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);
  return null;
}
